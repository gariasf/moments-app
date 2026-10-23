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
	"net/http"
	"os"
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
	slog.Info("listening", "addr", addr, "home", home.Name(), "data", data)
	err = http.ListenAndServe(addr, newHandler(home, data))
	slog.Error("server stopped", "err", err)
	os.Exit(1)
}

// newHandler serves the UI, and the API over the folder home, with its cache
// in the app data folder data. Every path the page sends goes through home,
// so it can't reach outside it, through ".." or a link.
func newHandler(home *os.Root, data string) http.Handler {
	ui, _ := fs.Sub(dist, "web/dist") // errors only on an invalid path
	mux := http.NewServeMux()
	mux.Handle("/", http.FileServerFS(ui))
	// ?path= lists a folder, "" being Home; ?q= searches all of Home instead.
	mux.HandleFunc("GET /api/sources", func(w http.ResponseWriter, r *http.Request) {
		var l listing
		var err error
		if q := r.URL.Query().Get("q"); strings.TrimSpace(q) != "" {
			l = searchVideos(home.FS(), q)
		} else {
			l, err = listFolder(home.FS(), r.URL.Query().Get("path"))
		}
		if err != nil {
			// Outside Home, hidden or missing alike, so nothing outside is confirmed to exist.
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(l)
	})
	// How the Trimmer opens the Source at ?path=, and its stream from the time
	// ?from=, in seconds of the Source's own time, with the audio track ?audio=,
	// counted from 0 in the probe's list, else the default (media.go).
	mux.HandleFunc("GET /api/source", func(w http.ResponseWriter, r *http.Request) {
		src, err := sourceFile(home, r.URL.Query().Get("path"))
		if err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		defer src.Close()
		p, err := probeSource(r.Context(), src)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(p)
	})
	mux.HandleFunc("GET /api/source/stream", func(w http.ResponseWriter, r *http.Request) {
		from, err := strconv.ParseFloat(cmp.Or(r.URL.Query().Get("from"), "0"), 64)
		if err != nil || math.IsNaN(from) || math.IsInf(from, 0) {
			http.Error(w, "from isn't a time in seconds", http.StatusBadRequest)
			return
		}
		src, err := sourceFile(home, r.URL.Query().Get("path"))
		if err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		defer src.Close()
		s, err := readSource(r.Context(), src)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if why := s.cantPlay(); why != "" {
			http.Error(w, "The Trimmer can't play this Source: "+why+".", http.StatusUnprocessableEntity)
			return
		}
		if audio := r.URL.Query().Get("audio"); audio != "" {
			n, err := strconv.Atoi(audio)
			if err != nil || n < 0 || n >= len(s.tracks) {
				http.Error(w, "audio isn't one of the Source's audio tracks", http.StatusBadRequest)
				return
			}
			s.audio = &s.tracks[n]
		}
		if err := streamSource(r.Context(), src, s, from, &typedStream{ResponseWriter: w}); err != nil {
			slog.Error("stream failed", "path", r.URL.Query().Get("path"), "err", err)
		}
	})
	// A thumbnail of the Source at ?path= for the time ?at=, in seconds of its
	// own time (media.go), cached in app data.
	mux.HandleFunc("GET /api/source/thumbnail", func(w http.ResponseWriter, r *http.Request) {
		at, err := strconv.ParseFloat(cmp.Or(r.URL.Query().Get("at"), "0"), 64)
		if err != nil || math.IsNaN(at) || math.IsInf(at, 0) {
			http.Error(w, "at isn't a time in seconds", http.StatusBadRequest)
			return
		}
		src, err := sourceFile(home, r.URL.Query().Get("path"))
		if err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		defer src.Close()
		info, err := src.Stat()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		// Named after the Source's path, size and modification time too, so a
		// Source replaced in place gets thumbnails of its own.
		name := fmt.Sprintf("thumbnails/%x.jpg", sha256.Sum256(fmt.Appendf(nil, "%q %d %d %g", src.Name(), info.Size(), info.ModTime().UnixNano(), at)))
		jpeg, err := cached(data, name, func() ([]byte, error) { return grabFrame(r.Context(), src, at) })
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "image/jpeg")
		w.Write(jpeg)
	})
	// Where a Moment of the Source at ?path= can start and end around the time
	// ?at=, in seconds of its own time (media.go): what the Trimmer's marks snap
	// to.
	mux.HandleFunc("GET /api/source/frames", func(w http.ResponseWriter, r *http.Request) {
		at, err := strconv.ParseFloat(cmp.Or(r.URL.Query().Get("at"), "0"), 64)
		if err != nil || math.IsNaN(at) || math.IsInf(at, 0) {
			http.Error(w, "at isn't a time in seconds", http.StatusBadRequest)
			return
		}
		src, err := sourceFile(home, r.URL.Query().Get("path"))
		if err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		defer src.Close()
		f, err := framesAround(r.Context(), src, at)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(f)
	})
	mux.HandleFunc("GET /api/mounts", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(mounts(home.Name()))
	})
	return mux
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

// writeWhole writes b to file, under another name until it's whole, so that
// nothing reads half of it, even after a crash.
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
	if err := errors.Join(err, tmp.Close()); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), file)
}
