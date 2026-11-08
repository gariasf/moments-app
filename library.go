package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// The Library is the MP4 files at the top level of the Moments folder in Home
// (ADR-0002), each titled by its file's name.

type moment struct {
	Title      string    `json:"title"`
	Length     float64   `json:"length"`
	SourceName string    `json:"sourceName,omitempty"`
	Created    time.Time `json:"created"`
	SourcePath string    `json:"sourcePath,omitempty"`
	Start      float64   `json:"start"`
	End        float64   `json:"end"`
}

func listLibrary(ctx context.Context, home *os.Root, data string) ([]moment, error) {
	entries, err := fs.ReadDir(home.FS(), "Moments")
	if errors.Is(err, fs.ErrNotExist) {
		return []moment{}, nil
	}
	if err != nil {
		return nil, err
	}
	library := []moment{}
	for _, entry := range entries {
		name := entry.Name()
		extension := filepath.Ext(name)
		if !isMoment(entry) {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		// Keyed on momentTags too, or Moments cached before a tag was added never show it.
		cacheName := fmt.Sprintf("library/%x.json", sha256.Sum256(fmt.Appendf(nil, "%q %d %d %s", name, info.Size(), info.ModTime().UnixNano(), momentTags)))
		var listed moment
		probedJSON, err := cached(data, cacheName, func() ([]byte, error) { return probeMoment(ctx, home, name) })
		if err == nil {
			err = json.Unmarshal(probedJSON, &listed)
		}
		if err != nil {
			slog.Error("can't read a Moment", "name", name, "err", err)
		}
		listed.Title = strings.TrimSuffix(name, extension)
		if listed.Created.IsZero() {
			listed.Created = info.ModTime().UTC()
		}
		library = append(library, listed)
	}
	slices.SortStableFunc(library, func(first, second moment) int { return second.Created.Compare(first.Created) })
	return library, nil
}

func isMoment(entry fs.DirEntry) bool {
	name := entry.Name()
	return !strings.HasPrefix(name, ".") && entry.Type().IsRegular() && strings.EqualFold(filepath.Ext(name), ".mp4")
}

func openMoment(home *os.Root, title string) (*os.File, error) {
	entries, err := fs.ReadDir(home.FS(), "Moments")
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		if name := entry.Name(); isMoment(entry) && strings.TrimSuffix(name, filepath.Ext(name)) == title {
			return home.Open(filepath.Join("Moments", name))
		}
	}
	return nil, fs.ErrNotExist
}

const momentTags = "creation_time,moments.source_name,moments.source_path,moments.start,moments.end"

func probeMoment(ctx context.Context, home *os.Root, name string) ([]byte, error) {
	file, err := home.Open(filepath.Join("Moments", name))
	if err != nil {
		return nil, err
	}
	defer file.Close()
	var output bytes.Buffer
	command := exec.CommandContext(ctx, "ffprobe", "-v", "error", "-of", "json",
		"-show_entries", "format=duration:format_tags="+momentTags, input)
	command.ExtraFiles, command.Stdout = []*os.File{file}, &output
	if err := runFFmpeg(command); err != nil {
		return nil, err
	}
	var probed struct {
		Format struct {
			Duration float64           `json:"duration,string"`
			Tags     map[string]string `json:"tags"`
		} `json:"format"`
	}
	if err := json.Unmarshal(output.Bytes(), &probed); err != nil {
		return nil, fmt.Errorf("reading ffprobe: %w", err)
	}
	tags := probed.Format.Tags
	probedMoment := moment{Length: probed.Format.Duration, SourceName: tags["moments.source_name"], SourcePath: tags["moments.source_path"]}
	probedMoment.Created, _ = time.Parse(time.RFC3339Nano, tags["creation_time"])
	probedMoment.Start, _ = strconv.ParseFloat(tags["moments.start"], 64)
	probedMoment.End, _ = strconv.ParseFloat(tags["moments.end"], 64)
	return json.Marshal(probedMoment)
}

// maxName is the most bytes a file's name takes, ext4's.
const maxName = 255

// cleanTitle makes t a title a Moment's file can be named after, and the
// Library shows: / is replaced, as yt-dlp replaces it in MeTube's file names,
// control characters become spaces, and leading dots, which would hide it, and
// spaces around it go.
func cleanTitle(t string) string {
	t = strings.Map(func(r rune) rune {
		switch {
		case r == '/':
			return '⧸'
		case unicode.IsControl(r):
			return ' '
		}
		return r
	}, t)
	t = strings.TrimLeftFunc(t, func(r rune) bool { return r == '.' || unicode.IsSpace(r) })
	return strings.TrimRightFunc(t, unicode.IsSpace)
}

// prefill is the title of a Moment of the Source named name, from start in
// seconds of its own time, when the owner gives it none: the name and the
// start, as Severance S02E07 · 12:34 (web/src/marks.ts).
func prefill(name string, start float64) string {
	s := int(max(start, 0))
	if s < 3600 {
		return fmt.Sprintf("%s · %d:%02d", name, s/60, s%60)
	}
	return fmt.Sprintf("%s · %d:%02d:%02d", name, s/3600, s/60%60, s%60)
}

// place renames the Moment at tmp, a dotfile in the Moments folder, into place
// as an MP4 named after title, cut to fit a file's name, with " (2)", " (3)"
// and so on after it when the name is taken, and returns the title it took.
func place(tmp, title string) (string, error) {
	for n := 1; ; n++ {
		suffix := ""
		if n > 1 {
			suffix = fmt.Sprintf(" (%d)", n)
		}
		name := fit(title, maxName-len(suffix+".mp4")) + suffix
		file := filepath.Join(filepath.Dir(tmp), name+".mp4")
		switch _, err := os.Lstat(file); {
		case errors.Is(err, fs.ErrNotExist):
			return name, os.Rename(tmp, file)
		case err != nil:
			return "", err
		}
	}
}

// fit cuts s to n bytes at most, between characters, and drops the spaces it
// leaves at its end.
func fit(s string, n int) string {
	for len(s) > n {
		_, size := utf8.DecodeLastRuneInString(s)
		s = s[:len(s)-size]
	}
	return strings.TrimRightFunc(s, unicode.IsSpace)
}
