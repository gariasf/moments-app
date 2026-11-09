// Command moments serves Moments: the UI, built into web/dist and embedded,
// and its API under /api/.
package main

import (
	"cmp"
	"crypto/sha256"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"math"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

//go:embed all:web/dist
var dist embed.FS

func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stdout, nil)))
	addr := os.Getenv("MOMENTS_ADDR")
	if addr == "" {
		addr = ":8080"
	}
	home, err := os.OpenRoot(os.Getenv("MOMENTS_HOME"))
	if err != nil {
		slog.Error("can't open Home: set MOMENTS_HOME to its folder", "err", err)
		os.Exit(1)
	}
	data := os.Getenv("MOMENTS_DATA")
	if info, err := os.Stat(data); err != nil || !info.IsDir() {
		slog.Error("can't find app data: set MOMENTS_DATA to its folder", "path", data)
		os.Exit(1)
	}
	handler, err := newHandler(home, data)
	if err != nil {
		slog.Error("can't pick up the Saves kept", "err", err)
		os.Exit(1)
	}
	slog.Info("listening", "addr", addr, "home", home.Name(), "data", data)
	err = http.ListenAndServe(addr, handler)
	slog.Error("server stopped", "err", err)
	os.Exit(1)
}

// newHandler serves the UI, and the API over the folder home, with its cache
// and its Saves in the app data folder data. Every path the page sends goes
// through home, so it can't reach outside it, through ".." or a link. It fails
// when the Saves kept there can't be read.
func newHandler(home *os.Root, data string) (http.Handler, error) {
	ui, _ := fs.Sub(dist, "web/dist") // errors only on an invalid path
	mux := http.NewServeMux()
	mux.Handle("/", http.FileServerFS(ui))
	// ?path= lists a folder, "" being Home and "Uploads" Uploads; ?q= searches
	// both instead.
	mux.HandleFunc("GET /api/sources", func(writer http.ResponseWriter, request *http.Request) {
		var listed listing
		var listError error
		query, folderPath := request.URL.Query().Get("q"), request.URL.Query().Get("path")
		switch {
		case strings.TrimSpace(query) != "":
			listed = searchVideos(home.FS(), query)
			uploaded, _ := listUploads(data, query)
			listed.Videos = append(listed.Videos, uploaded.Videos...)
		case folderPath == "Uploads":
			listed, listError = listUploads(data, "")
		default:
			listed, listError = listFolder(home.FS(), folderPath)
		}
		if listError != nil {
			// Outside Home, hidden or missing alike, so nothing outside is confirmed to exist.
			http.Error(writer, listError.Error(), http.StatusNotFound)
			return
		}
		for index := range listed.Videos {
			listed.Videos[index].Deletable = deletable(home, data, listed.Videos[index].Path)
		}
		writer.Header().Set("Content-Type", "application/json")
		json.NewEncoder(writer).Encode(listed)
	})
	// How the Trimmer opens the Source at ?path=, and its stream from the time
	// ?from=, in seconds of the Source's own time, with the audio track ?audio=,
	// counted from 0 in the probe's list, else the default (media.go).
	mux.HandleFunc("GET /api/source", func(writer http.ResponseWriter, request *http.Request) {
		source, failure := sourceFile(home, data, request.URL.Query().Get("path"))
		if failure != nil {
			http.Error(writer, failure.Error(), http.StatusNotFound)
			return
		}
		defer source.Close()
		probed, failure := probeSource(request.Context(), source)
		if failure != nil {
			http.Error(writer, failure.Error(), http.StatusInternalServerError)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		json.NewEncoder(writer).Encode(probed)
	})
	mux.HandleFunc("GET /api/source/stream", func(writer http.ResponseWriter, request *http.Request) {
		from, failure := strconv.ParseFloat(cmp.Or(request.URL.Query().Get("from"), "0"), 64)
		if failure != nil || math.IsNaN(from) || math.IsInf(from, 0) {
			http.Error(writer, "from isn't a time in seconds", http.StatusBadRequest)
			return
		}
		source, failure := sourceFile(home, data, request.URL.Query().Get("path"))
		if failure != nil {
			http.Error(writer, failure.Error(), http.StatusNotFound)
			return
		}
		defer source.Close()
		probed, failure := readSource(request.Context(), source)
		if failure != nil {
			http.Error(writer, failure.Error(), http.StatusInternalServerError)
			return
		}
		if why := probed.cantPlay(); why != "" {
			http.Error(writer, "The Trimmer can't play this Source: "+why+".", http.StatusUnprocessableEntity)
			return
		}
		if audio := request.URL.Query().Get("audio"); audio != "" {
			track, failure := strconv.Atoi(audio)
			if failure != nil || track < 0 || track >= len(probed.tracks) {
				http.Error(writer, "audio isn't one of the Source's audio tracks", http.StatusBadRequest)
				return
			}
			probed.audio = &probed.tracks[track]
		}
		if failure := streamSource(request.Context(), source, probed, from, &typedStream{ResponseWriter: writer}); failure != nil {
			slog.Error("stream failed", "path", request.URL.Query().Get("path"), "err", failure)
		}
	})
	// A thumbnail of the Source at ?path= for the time ?at=, in seconds of its
	// own time (media.go), cached in app data.
	mux.HandleFunc("GET /api/source/thumbnail", func(writer http.ResponseWriter, request *http.Request) {
		at, failure := strconv.ParseFloat(cmp.Or(request.URL.Query().Get("at"), "0"), 64)
		if failure != nil || math.IsNaN(at) || math.IsInf(at, 0) {
			http.Error(writer, "at isn't a time in seconds", http.StatusBadRequest)
			return
		}
		source, failure := sourceFile(home, data, request.URL.Query().Get("path"))
		if failure != nil {
			http.Error(writer, failure.Error(), http.StatusNotFound)
			return
		}
		defer source.Close()
		info, failure := source.Stat()
		if failure != nil {
			http.Error(writer, failure.Error(), http.StatusInternalServerError)
			return
		}
		// Named after the Source's path, size and modification time too, so a
		// Source replaced in place gets thumbnails of its own.
		name := fmt.Sprintf("thumbnails/%x.jpg", sha256.Sum256(fmt.Appendf(nil, "%q %d %d %g", source.Name(), info.Size(), info.ModTime().UnixNano(), at)))
		jpeg, failure := cached(data, name, func() ([]byte, error) { return grabFrame(request.Context(), source, at, 320) })
		if failure != nil {
			http.Error(writer, failure.Error(), http.StatusInternalServerError)
			return
		}
		writer.Header().Set("Content-Type", "image/jpeg")
		writer.Write(jpeg)
	})
	// Where a Moment of the Source at ?path= can start and end around the time
	// ?at=, through the time ?to= when given, in seconds of its own time
	// (media.go): what the Trimmer's marks snap and nudge to.
	mux.HandleFunc("GET /api/source/frames", func(writer http.ResponseWriter, request *http.Request) {
		at, failure := strconv.ParseFloat(cmp.Or(request.URL.Query().Get("at"), "0"), 64)
		if failure != nil || math.IsNaN(at) || math.IsInf(at, 0) {
			http.Error(writer, "at isn't a time in seconds", http.StatusBadRequest)
			return
		}
		to, failure := strconv.ParseFloat(cmp.Or(request.URL.Query().Get("to"), request.URL.Query().Get("at"), "0"), 64)
		if failure != nil || math.IsNaN(to) || math.IsInf(to, 0) {
			http.Error(writer, "to isn't a time in seconds", http.StatusBadRequest)
			return
		}
		source, failure := sourceFile(home, data, request.URL.Query().Get("path"))
		if failure != nil {
			http.Error(writer, failure.Error(), http.StatusNotFound)
			return
		}
		defer source.Close()
		frames, failure := framesAround(request.Context(), source, at, to)
		if failure != nil {
			http.Error(writer, failure.Error(), http.StatusInternalServerError)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		json.NewEncoder(writer).Encode(frames)
	})
	if makeError := os.MkdirAll(filepath.Join(data, "uploads"), 0o755); makeError != nil {
		return nil, makeError
	}
	removeHalfWritten(filepath.Join(data, "uploads"), ".uploading-")
	// Saves the Moment of the Source at path from start to end, in seconds of
	// its own time, with the audio track audio, counted from 0 in the probe's
	// list, else the default, under title (saves.go). It answers at once: the
	// Save runs on its own, and GET lists it until it's done.
	saves, err := newSaves(home, data)
	if err != nil {
		return nil, err
	}
	mux.HandleFunc("POST /api/saves", func(writer http.ResponseWriter, request *http.Request) {
		var planned save
		if failure := json.NewDecoder(request.Body).Decode(&planned); failure != nil {
			http.Error(writer, "the Save isn't JSON: "+failure.Error(), http.StatusBadRequest)
			return
		}
		if planned.End < planned.Start {
			http.Error(writer, "the Save ends before it starts", http.StatusBadRequest)
			return
		}
		source, failure := sourceFile(home, data, planned.Path)
		if failure != nil {
			http.Error(writer, failure.Error(), http.StatusNotFound)
			return
		}
		defer source.Close()
		probed, failure := readSource(request.Context(), source)
		if failure != nil {
			http.Error(writer, failure.Error(), http.StatusInternalServerError)
			return
		}
		if planned.Audio != nil && (*planned.Audio < 0 || *planned.Audio >= len(probed.tracks)) {
			http.Error(writer, "audio isn't one of the Source's audio tracks", http.StatusBadRequest)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusAccepted)
		json.NewEncoder(writer).Encode(saves.add(planned))
	})
	mux.HandleFunc("GET /api/saves", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		type namedSave struct {
			save
			SourceName string `json:"sourceName"`
		}
		listed := []namedSave{}
		for _, each := range saves.all() {
			listed = append(listed, namedSave{each, sourceName(home.FS(), each.Path)})
		}
		json.NewEncoder(w).Encode(listed)
	})
	refuse := func(w http.ResponseWriter, err error) {
		status := http.StatusBadRequest
		switch err {
		case errNoSave:
			status = http.StatusNotFound
		case errNotFailed:
			status = http.StatusConflict
		}
		http.Error(w, err.Error(), status)
	}
	mux.HandleFunc("POST /api/saves/{id}/retry", func(w http.ResponseWriter, r *http.Request) {
		var s save
		id, err := strconv.Atoi(r.PathValue("id"))
		if err == nil {
			s, err = saves.retry(id)
		}
		if err != nil {
			refuse(w, err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(s)
	})
	mux.HandleFunc("DELETE /api/saves/{id}", func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.Atoi(r.PathValue("id"))
		if err == nil {
			err = saves.dismiss(id)
		}
		if err != nil {
			refuse(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	// Receives the upload of a video named ?name= as the request's body, into
	// Uploads.
	mux.HandleFunc("POST /api/uploads", func(writer http.ResponseWriter, request *http.Request) {
		name := request.URL.Query().Get("name")
		if !uploadable(name) {
			http.Error(writer, "Moments uploads only videos, under a file name", http.StatusBadRequest)
			return
		}
		uploaded, uploadError := receiveUpload(data, name, request.Body)
		if uploadError != nil {
			slog.Error("upload failed", "name", name, "err", uploadError)
			http.Error(writer, uploadError.Error(), http.StatusInternalServerError)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusCreated)
		json.NewEncoder(writer).Encode(uploaded)
	})
	mux.HandleFunc("DELETE /api/sources", func(writer http.ResponseWriter, request *http.Request) {
		sourcePath := request.URL.Query().Get("path")
		root, inside, source, checkError := checkDeletable(home, data, sourcePath)
		if checkError != nil {
			status := notFoundOrServerError(checkError)
			if errors.Is(checkError, errNotDeletable) {
				status = http.StatusForbidden
			}
			http.Error(writer, checkError.Error(), status)
			return
		}
		defer root.Close()
		isSource := func(savePath string) bool {
			saved, statError := home.Stat(savePath)
			return path.Clean(savePath) == sourcePath || statError == nil && os.SameFile(source, saved)
		}
		removeError := saves.unlessNeeded(isSource, func() error { return root.Remove(inside) })
		switch {
		case removeError == nil:
			writer.WriteHeader(http.StatusNoContent)
		case errors.Is(removeError, errSourceNeeded):
			http.Error(writer, removeError.Error(), http.StatusConflict)
		default:
			http.Error(writer, removeError.Error(), notFoundOrServerError(removeError))
		}
	})
	mux.HandleFunc("GET /api/moments", func(w http.ResponseWriter, r *http.Request) {
		library, err := listLibrary(r.Context(), home, data)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(library)
	})
	mux.HandleFunc("GET /api/moments/{title}/poster", func(writer http.ResponseWriter, request *http.Request) {
		file, openError := openMoment(home, request.PathValue("title"))
		if openError != nil {
			http.Error(writer, openError.Error(), http.StatusNotFound)
			return
		}
		defer file.Close()
		info, statError := file.Stat()
		if statError != nil {
			http.Error(writer, statError.Error(), http.StatusInternalServerError)
			return
		}
		jpeg, grabError := cached(data, posterName(info), func() ([]byte, error) { return grabFrame(request.Context(), file, 0, 640) })
		if grabError != nil {
			http.Error(writer, grabError.Error(), http.StatusInternalServerError)
			return
		}
		writer.Header().Set("Content-Type", "image/jpeg")
		writer.Write(jpeg)
	})
	mux.HandleFunc("GET /api/moments/{title}/file", func(writer http.ResponseWriter, request *http.Request) {
		file, openError := openMoment(home, request.PathValue("title"))
		if openError != nil {
			http.Error(writer, openError.Error(), http.StatusNotFound)
			return
		}
		defer file.Close()
		info, statError := file.Stat()
		if statError != nil {
			http.Error(writer, statError.Error(), http.StatusInternalServerError)
			return
		}
		writer.Header().Set("Content-Type", "video/mp4")
		if request.URL.Query().Has("download") {
			writer.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": request.PathValue("title") + ".mp4"}))
		}
		http.ServeContent(writer, request, info.Name(), info.ModTime(), file)
	})
	mux.HandleFunc("PATCH /api/moments/{title}", func(writer http.ResponseWriter, request *http.Request) {
		var asked struct{ Title string }
		if decodeError := json.NewDecoder(request.Body).Decode(&asked); decodeError != nil {
			http.Error(writer, "the rename isn't JSON: "+decodeError.Error(), http.StatusBadRequest)
			return
		}
		title, renameError := renameMoment(request.Context(), home, request.PathValue("title"), asked.Title)
		if renameError != nil {
			http.Error(writer, renameError.Error(), notFoundOrServerError(renameError))
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		json.NewEncoder(writer).Encode(moment{Title: title})
	})
	mux.HandleFunc("DELETE /api/moments/{title}", func(writer http.ResponseWriter, request *http.Request) {
		if deleteError := deleteMoment(home, data, request.PathValue("title")); deleteError != nil {
			http.Error(writer, deleteError.Error(), notFoundOrServerError(deleteError))
			return
		}
		writer.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("GET /api/mounts", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(mounts(home.Name()))
	})
	return mux, nil
}

func notFoundOrServerError(failure error) int {
	if errors.Is(failure, fs.ErrNotExist) {
		return http.StatusNotFound
	}
	return http.StatusInternalServerError
}

// typedStream passes a stream on to the page with, as its Content-Type, the
// codecs MediaSource needs for it, read from its start up to its moov
// (media.go): a stream of another audio track can need others than the
// probe's.
type typedStream struct {
	http.ResponseWriter
	start []byte // the stream, held back until its moov is in
	sent  bool
}

func (t *typedStream) Write(b []byte) (int, error) {
	if t.sent {
		return t.ResponseWriter.Write(b)
	}
	t.start = append(t.start, b...)
	if mp4Box(t.start, "moov") == nil {
		return len(b), nil
	}
	codecs, err := codecs(t.start)
	if err != nil {
		return 0, err
	}
	t.Header().Set("Content-Type", fmt.Sprintf(`video/mp4; codecs="%s"`, codecs))
	t.sent = true
	_, err = t.ResponseWriter.Write(t.start)
	return len(b), err
}

// A mount is a folder in Home that the package mounts for the server, ""
// being Home: how the server finds it, and how it should be.
type mount struct {
	Path   string `json:"path"`
	Access string `json:"access"` // "read-only", "writable" or "missing"
	Want   string `json:"want"`   // "read-only" or "writable"
}

// mounts finds how the folders in the Home at home are mounted. All of Home
// should be read-only, with MeTube's downloads and the Moments folder writable
// on top: the only Sources in Home that the server deletes are in
// Downloads/metube, and the only files it writes in Home are Moments.
func mounts(home string) []mount {
	ms := []mount{{Path: "", Want: "read-only"}, {Path: "Downloads/metube", Want: "writable"}, {Path: "Moments", Want: "writable"}}
	for i := range ms {
		// access(2) asks the mount and the permissions both, without writing.
		switch err := syscall.Access(filepath.Join(home, ms[i].Path), 2); { // 2 is W_OK
		case err == nil:
			ms[i].Access = "writable"
		case errors.Is(err, fs.ErrNotExist):
			ms[i].Access = "missing"
		default:
			ms[i].Access = "read-only"
		}
	}
	return ms
}

// cached returns what the cache, in the app data folder data, holds as name,
// or else what build makes, kept there. The cache is made again as it's asked
// for, so any of it can be deleted.
//
// ponytail: never shrinks; a thumbnail is a few KB, one for each pixel of the
// seek bar hovered over, so a few MB a Source at most. Delete the oldest if
// app data grows.
func cached(data, name string, build func() ([]byte, error)) ([]byte, error) {
	file := filepath.Join(data, "cache", name)
	if b, err := os.ReadFile(file); err == nil {
		return b, nil
	}
	b, err := build()
	if err != nil {
		return nil, err
	}
	if err := writeWhole(file, b); err != nil {
		slog.Error("can't cache", "file", file, "err", err)
	}
	return b, nil
}

// writeWhole writes b to file, under another name until it's whole and on
// disk, so that nothing reads half of it, even after a crash or a power cut.
func writeWhole(file string, b []byte) error {
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(file), ".writing-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name()) // nothing to remove once renamed
	_, err = tmp.Write(b)
	if err := errors.Join(err, tmp.Sync(), tmp.Close()); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), file)
}
