package main

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

// A save is a Moment on its way into the Library, from pressing Save in the
// Trimmer until its file is in the Moments folder, as GET /api/saves lists it.
type save struct {
	ID    int     `json:"id"`
	Path  string  `json:"path"`  // the Source's, as the page sends it
	Start float64 `json:"start"` // the marks, in seconds of the Source's own time
	End   float64 `json:"end"`
	// The audio track, counted from 0 in the probe's list (media.go); nil for
	// the Source's default.
	Audio   *int   `json:"audio,omitempty"`
	Title   string `json:"title"`           // as the owner gave it (library.go)
	State   string `json:"state"`           // waiting, saving or failed
	Error   string `json:"error,omitempty"` // why it failed
	Percent int    `json:"percent,omitempty"`
}

// saves holds the Saves not yet done, in the order they were made, and saves
// them one at a time, which leaves the Umbrel's other cores to the Trimmer.
// It keeps them in saves.json too, so they outlast a restart.
type saves struct {
	mu   sync.Mutex
	list []save
	last int           // the latest Save's ID
	wake chan struct{} // tells the worker a Save is waiting
	file string
}

// newSaves starts the worker that saves Moments from the Sources in home into
// its Moments folder, beginning with those kept in the app data folder data.
// A Save runs on its own, whether the page that made it stays open or not.
func newSaves(home *os.Root, data string) (*saves, error) {
	ss := &saves{wake: make(chan struct{}, 1), file: filepath.Join(data, "saves.json")}
	kept, err := os.ReadFile(ss.file)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	if err == nil {
		if err := json.Unmarshal(kept, &ss.list); err != nil {
			slog.Error("can't read the Saves kept, so they're set aside", "file", ss.file+".unreadable", "err", err)
			ss.list = nil
			if err := os.Rename(ss.file, ss.file+".unreadable"); err != nil {
				return nil, err
			}
		}
	}
	for i := range ss.list {
		if ss.list[i].State == "saving" { // the one a stop interrupted starts over
			ss.list[i].State, ss.list[i].Percent = "waiting", 0
		}
		ss.last = max(ss.last, ss.list[i].ID)
	}
	removeHalfWritten(filepath.Join(home.Name(), "Moments"), ".saving-")
	go func() {
		for range ss.wake {
			for pending, ok := ss.next(); ok; pending, ok = ss.next() {
				step, err := saveMoment(context.Background(), home, data, pending, func(percent int) { ss.progress(pending.ID, percent) })
				failure := ""
				if err != nil {
					slog.Error("save failed", "path", pending.Path, "title", pending.Title, "step", step, "err", err)
					lines := strings.Split(strings.TrimSpace(err.Error()), "\n")
					failure = step + " failed: " + lines[len(lines)-1]
				}
				ss.finish(pending.ID, failure)
			}
		}
	}()
	ss.poke()
	return ss, nil
}

// removeHalfWritten removes the half-written files a stop left in folder,
// those whose names start with prefix, and none of the other dotfiles there,
// such as .DS_Store.
func removeHalfWritten(folder, prefix string) {
	entries, readError := os.ReadDir(folder)
	if readError != nil {
		slog.Error("can't clean up", "folder", folder, "err", readError)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), prefix) {
			if removeError := os.Remove(filepath.Join(folder, entry.Name())); removeError != nil {
				slog.Error("can't remove a half-written file", "err", removeError)
			}
		}
	}
}

// keep rewrites saves.json whole with the Saves listed. ss.mu is held.
//
// Fields are only ever added to a save, so that the release before can read it.
func (ss *saves) keep() {
	encoded, _ := json.Marshal(ss.list) // a save always marshals
	if err := writeWhole(ss.file, encoded); err != nil {
		slog.Error("can't keep the Saves", "file", ss.file, "err", err)
	}
}

// add puts s at the back of the line, and returns it as listed.
func (ss *saves) add(s save) save {
	ss.mu.Lock()
	defer ss.mu.Unlock()
	// By the millisecond it's made, so an ID a page holds from before a
	// restart is never another Save's.
	ss.last = max(int(time.Now().UnixMilli()), ss.last+1)
	s.ID, s.State, s.Error = ss.last, "waiting", ""
	ss.list = append(ss.list, s)
	ss.keep()
	ss.poke()
	return s
}

func (ss *saves) poke() {
	select {
	case ss.wake <- struct{}{}:
	default: // the worker was told already
	}
}

var (
	errNoSave    = errors.New("no such Save")
	errNotFailed = errors.New("the Save hasn't failed")
)

func (ss *saves) indexOf(id int) int {
	return slices.IndexFunc(ss.list, func(listed save) bool { return listed.ID == id })
}

func (ss *saves) findFailed(id int) (int, error) {
	index := ss.indexOf(id)
	if index < 0 {
		return index, errNoSave
	}
	if ss.list[index].State != "failed" {
		return index, errNotFailed
	}
	return index, nil
}

func (ss *saves) retry(id int) (save, error) {
	ss.mu.Lock()
	defer ss.mu.Unlock()
	index, err := ss.findFailed(id)
	if err != nil {
		return save{}, err
	}
	retried := ss.list[index]
	retried.State, retried.Error = "waiting", ""
	ss.list = append(slices.Delete(ss.list, index, index+1), retried)
	ss.keep()
	ss.poke()
	return retried, nil
}

func (ss *saves) dismiss(id int) error {
	ss.mu.Lock()
	defer ss.mu.Unlock()
	index, err := ss.findFailed(id)
	if err == nil {
		ss.list = slices.Delete(ss.list, index, index+1)
		ss.keep()
	}
	return err
}

var errSourceNeeded = errors.New("a Save from this Source is waiting, saving or failed, and a retry needs the Source")

func (ss *saves) unlessNeeded(isSource func(savePath string) bool, remove func() error) error {
	ss.mu.Lock()
	defer ss.mu.Unlock()
	if slices.ContainsFunc(ss.list, func(listed save) bool { return isSource(listed.Path) }) {
		return errSourceNeeded
	}
	return remove()
}

// all lists the Saves not yet done, in the order they were made.
func (ss *saves) all() []save {
	ss.mu.Lock()
	defer ss.mu.Unlock()
	return append([]save{}, ss.list...)
}

// next starts the first Save waiting, if there's one.
func (ss *saves) next() (save, bool) {
	ss.mu.Lock()
	defer ss.mu.Unlock()
	i := slices.IndexFunc(ss.list, func(s save) bool { return s.State == "waiting" })
	if i < 0 {
		return save{}, false
	}
	ss.list[i].State, ss.list[i].Percent = "saving", 0
	ss.keep()
	return ss.list[i], true
}

func (ss *saves) progress(id, percent int) {
	ss.mu.Lock()
	defer ss.mu.Unlock()
	if index := ss.indexOf(id); index >= 0 {
		ss.list[index].Percent = percent
	}
}

// finish ends the Save numbered id: it's done once its Moment is in the
// Library, or else failed, saying why.
func (ss *saves) finish(id int, failure string) {
	ss.mu.Lock()
	defer ss.mu.Unlock()
	defer ss.keep()
	index := ss.indexOf(id)
	if failure == "" {
		ss.list = slices.Delete(ss.list, index, index+1)
		return
	}
	ss.list[index].State, ss.list[index].Error = "failed", failure
}

// saveMoment cuts the Moment planned from its Source, in home or in Uploads in
// the app data folder data, into the Moments folder, as a dotfile until it's
// whole, which the Library ignores, then puts it in place under its title
// (library.go). A rename across two mounts isn't atomic, so the dotfile is in
// the Moments folder itself.
func saveMoment(saveContext context.Context, home *os.Root, data string, planned save, progress func(percent int)) (step string, failure error) {
	opened, failure := sourceFile(home, data, planned.Path)
	if failure != nil {
		return "Open", failure
	}
	defer opened.Close()
	probed, failure := readSource(saveContext, opened)
	if failure != nil {
		return "Read", failure
	}
	if planned.Audio != nil {
		if *planned.Audio >= len(probed.tracks) { // the Source was replaced since
			return "Read", errors.New("the audio track chosen is gone")
		}
		probed.audio = &probed.tracks[*planned.Audio]
	}
	// FFmpeg makes it as any file in Home is made, rather than the owner's
	// alone, as a temporary file is.
	dotfile := filepath.Join(home.Name(), "Moments", fmt.Sprintf(".saving-%d.mp4", planned.ID))
	defer os.Remove(dotfile) // nothing to remove once placed
	named := sourceName(home.FS(), planned.Path)
	start, lastFrame, failure := cutMoment(saveContext, opened, probed, named, planned.Path, planned.Start, planned.End, dotfile, progress)
	if failure != nil {
		return "Write", failure
	}
	if failure := checkSave(saveContext, dotfile, lastFrame-start, probed.video.frameLength()); failure != nil {
		return "Check", failure
	}
	_, failure = place(dotfile, cmp.Or(cleanTitle(planned.Title), cleanTitle(prefill(named, start))), ".mp4")
	return "Move", failure
}

var checkSave = checkMoment
