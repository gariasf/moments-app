package main

import (
	"errors"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
)

// A listing is what the Source browser shows: folders, and videos with their
// sizes in bytes. Paths are relative to Home, as Files shows them.
type listing struct {
	Folders []folder `json:"folders"`
	Videos  []video  `json:"videos"`
}

type folder struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

type video struct {
	Name       string `json:"name"` // the file's
	Path       string `json:"path"`
	Size       int64  `json:"size"`
	SourceName string `json:"sourceName"` // from its folders, as the Trimmer shows it (sourceName)
	Deletable  bool   `json:"deletable,omitempty"`
}

// videoExts recognises videos by extension. .ts is left out: in a Home it's
// TypeScript as often as video.
var videoExts = map[string]bool{
	".avi": true, ".m2ts": true, ".m4v": true, ".mkv": true, ".mov": true, ".mp4": true,
	".mpeg": true, ".mpg": true, ".mts": true, ".webm": true, ".wmv": true,
}

// isVideo reports whether e is a video file. A link isn't one.
func isVideo(e fs.DirEntry) bool {
	return e.Type().IsRegular() && videoExts[strings.ToLower(path.Ext(e.Name()))]
}

// hidden reports whether the page never sees the file or folder at p in Home:
// the Moments folder, since a Moment isn't a Source, a folder named Uploads,
// since the page's Uploads are in app data, and dotfiles and dot-folders, with
// all that's in them.
func hidden(p string) bool {
	for _, shadowed := range []string{"Moments", "Uploads"} {
		if p == shadowed || strings.HasPrefix(p, shadowed+"/") {
			return true
		}
	}
	return p != "." && strings.HasPrefix(p, ".") || strings.Contains(p, "/.")
}

// sourceFile opens the file at sourcePath, a path as the page sends it, in
// home, or in Uploads in the app data folder data. Like a listing, it can't
// reach outside either or into hidden folders.
func sourceFile(home *os.Root, data, sourcePath string) (*os.File, error) {
	root, inside := home, sourcePath
	if inUploads, found := strings.CutPrefix(sourcePath, "Uploads/"); found {
		uploads, openError := os.OpenRoot(filepath.Join(data, "uploads"))
		if openError != nil {
			return nil, openError
		}
		defer uploads.Close()
		root, inside = uploads, inUploads
	}
	if hidden(inside) {
		return nil, &fs.PathError{Op: "open", Path: sourcePath, Err: fs.ErrNotExist}
	}
	// Checked before opening, since opening a pipe would wait for a writer.
	info, statError := fs.Stat(root.FS(), inside)
	if statError != nil {
		return nil, statError
	}
	if !info.Mode().IsRegular() {
		return nil, &fs.PathError{Op: "open", Path: sourcePath, Err: fs.ErrNotExist}
	}
	return root.Open(inside)
}

func listUploads(data, query string) (listing, error) {
	uploads := os.DirFS(filepath.Join(data, "uploads"))
	var listed listing
	var listError error
	if strings.TrimSpace(query) != "" {
		listed = searchVideos(uploads, query)
	} else {
		listed, listError = listFolder(uploads, "")
	}
	listed.Folders = []folder{}
	for index := range listed.Videos {
		listed.Videos[index].Path = "Uploads/" + listed.Videos[index].Path
	}
	return listed, listError
}

func uploadable(name string) bool {
	return name == path.Base(name) && !strings.HasPrefix(name, ".") && videoExts[strings.ToLower(path.Ext(name))]
}

// receiveUpload streams body into Uploads, in the app data folder data, as a
// dotfile until it's whole, then puts it in place under name. A body cut off
// leaves nothing behind.
func receiveUpload(data, name string, body io.Reader) (video, error) {
	uploads := filepath.Join(data, "uploads")
	temporary, createError := os.CreateTemp(uploads, ".uploading-*")
	if createError != nil {
		return video{}, createError
	}
	defer os.Remove(temporary.Name())
	size, copyError := io.Copy(temporary, body)
	if failure := errors.Join(copyError, temporary.Sync(), temporary.Close()); failure != nil {
		return video{}, failure
	}
	extension := path.Ext(name)
	placed, placeError := place(temporary.Name(), strings.TrimSuffix(name, extension), extension)
	if placeError != nil {
		return video{}, placeError
	}
	return video{Name: placed + extension, Path: "Uploads/" + placed + extension, Size: size, SourceName: placed, Deletable: true}, nil
}

var errNotDeletable = errors.New("Moments deletes only the videos in Uploads and Downloads/metube")

// Opened as a root, the folder refuses links and ".." out of it.
func deletableFolder(home *os.Root, data, sourcePath string) (root *os.Root, inside string, failure error) {
	if sourcePath != path.Clean(sourcePath) || !videoExts[strings.ToLower(path.Ext(sourcePath))] {
		return nil, "", errNotDeletable
	}
	if inside, found := strings.CutPrefix(sourcePath, "Downloads/metube/"); found && !hidden(sourcePath) {
		if info, lstatError := home.Lstat("Downloads/metube"); lstatError == nil && !info.IsDir() {
			return nil, "", errNotDeletable
		}
		root, failure = home.OpenRoot("Downloads/metube")
		return root, inside, failure
	}
	if inside, found := strings.CutPrefix(sourcePath, "Uploads/"); found && !hidden(inside) {
		root, failure = os.OpenRoot(filepath.Join(data, "uploads"))
		return root, inside, failure
	}
	return nil, "", errNotDeletable
}

func checkDeletable(home *os.Root, data, sourcePath string) (root *os.Root, inside string, info fs.FileInfo, failure error) {
	root, inside, failure = deletableFolder(home, data, sourcePath)
	if failure != nil {
		return nil, "", nil, failure
	}
	info, lstatError := root.Lstat(inside)
	switch {
	case errors.Is(lstatError, fs.ErrNotExist):
		failure = lstatError
	case lstatError != nil || !info.Mode().IsRegular():
		failure = errNotDeletable
	default:
		return root, inside, info, nil
	}
	root.Close()
	return nil, "", nil, failure
}

func deletable(home *os.Root, data, sourcePath string) bool {
	root, _, _, failure := checkDeletable(home, data, sourcePath)
	if failure == nil {
		root.Close()
	}
	return failure == nil
}

// listFolder lists the folder dir in home, "" being Home itself. Links aren't
// listed.
func listFolder(home fs.FS, dir string) (listing, error) {
	if dir == "" {
		dir = "."
	}
	if hidden(dir) {
		return listing{}, &fs.PathError{Op: "open", Path: dir, Err: fs.ErrNotExist}
	}
	entries, readError := fs.ReadDir(home, dir)
	if readError != nil {
		return listing{}, readError
	}
	listed := listing{Folders: []folder{}, Videos: []video{}}
	for _, entry := range entries {
		entryPath := path.Join(dir, entry.Name())
		switch {
		case hidden(entryPath):
		case entry.IsDir():
			listed.Folders = append(listed.Folders, folder{entry.Name(), entryPath})
		case isVideo(entry):
			if info, infoError := entry.Info(); infoError == nil { // else gone since the folder was read
				listed.Videos = append(listed.Videos, video{Name: entry.Name(), Path: entryPath, Size: info.Size(), SourceName: sourceName(home, entryPath)})
			}
		}
	}
	return listed, nil
}

// searchVideos finds the videos in home whose path has every word of query
// in it, ignoring case, so file and folder names both match. Links aren't
// followed.
//
// ponytail: walks all of Home per search, about 1,400 files and folders on
// the Umbrel; an index if that grows a hundredfold.
func searchVideos(home fs.FS, query string) listing {
	words := strings.Fields(strings.ToLower(query))
	found := listing{Folders: []folder{}, Videos: []video{}}
	fs.WalkDir(home, ".", func(entryPath string, entry fs.DirEntry, walkError error) error {
		switch {
		case walkError != nil:
			return nil // an unreadable folder: search the rest
		case hidden(entryPath) && entry.IsDir():
			return fs.SkipDir
		case hidden(entryPath) || !isVideo(entry):
			return nil
		}
		lower := strings.ToLower(entryPath)
		for _, word := range words {
			if !strings.Contains(lower, word) {
				return nil
			}
		}
		if info, infoError := entry.Info(); infoError == nil {
			found.Videos = append(found.Videos, video{Name: entry.Name(), Path: entryPath, Size: info.Size(), SourceName: sourceName(home, entryPath)})
		}
		return nil
	})
	return found
}

var (
	// movieFolder matches a movie folder's name, as Jellyfin names them, up to
	// its year: Tears of Steel (2012), then maybe tags, such as [1080p].
	movieFolder = regexp.MustCompile(`^.*?\(\d{4}\)`)
	// sample matches the file name of a release's sample, such as
	// sample-Movie.2008.mkv or Movie.2008.Sample.mkv.
	sample = regexp.MustCompile(`(?i)^sample-|[-_. ]sample\.[^.]+$`)
	// seasonFolder matches a season folder's name, such as Season 2 or S01,
	// with its season.
	seasonFolder = regexp.MustCompile(`(?i)^(?:season ?|s)(\d+)$`)
	// episodeCode finds an episode's code in a file name: S02E07, which
	// releases also write S02 E07, s2e7, or S02E01E02 for two episodes.
	episodeCode = regexp.MustCompile(`(?i)(?:^|[^a-z0-9])(s\d+ ?e\d+(?:e\d+)*)(?:[^a-z0-9]|$)`)
	// creditless finds the opening or ending anime releases add, with or
	// without its credits, in capitals: OP, ED, NCOP1, NCED 2.
	creditless = regexp.MustCompile(`(?:^|[^A-Za-z0-9])((?:NC)?(?:OP|ED)) ?(\d*)(?:[^A-Za-z0-9]|$)`)
	// episodeNumber finds an episode numbered within its season, as anime
	// releases number them: Ep 01, EP1, Session_01, or Ep 11.5 between two.
	episodeNumber = regexp.MustCompile(`(?i)(?:^|[^a-z0-9])(?:ep|session)[ ._]?(\d+)(\.\d)?(?:[^a-z0-9]|$)`)
	// number finds each number in an episode's code.
	number = regexp.MustCompile(`\d+`)
)

// sourceName names the Source at p in home the way the owner thinks of it,
// from its folders (#10): in a season folder, by the show and the episode
// code, as Pioneer One S02E07; the one video in a movie folder, samples aside,
// by the folder's name up to the year, as Tears of Steel (2012); any other
// by its file's name without the extension, as MeTube's titles and uploads.
func sourceName(home fs.FS, p string) string {
	dir, base := path.Dir(p), strings.TrimSuffix(path.Base(p), path.Ext(p))
	if season := seasonFolder.FindStringSubmatch(path.Base(dir)); season != nil {
		if code := episode(base, season[1]); code != "" {
			return path.Base(path.Dir(dir)) + " " + code
		}
	}
	if movie := movieFolder.FindString(path.Base(dir)); movie != "" && onlyVideo(home, p) {
		return movie
	}
	return base
}

// episode finds the code of the episode in base, a file name without its
// extension, in a season folder of the season season, such as S02E07; ""
// when it has none. An opening or ending goes before an episode's number,
// which it can name: NCED (Ep 12).
func episode(base, season string) string {
	if m := episodeCode.FindStringSubmatch(base); m != nil {
		return twoDigits(strings.ToUpper(strings.ReplaceAll(m[1], " ", "")))
	}
	if m := creditless.FindStringSubmatch(base); m != nil {
		return m[1] + m[2]
	}
	if m := episodeNumber.FindStringSubmatch(base); m != nil {
		return twoDigits("S"+season+"E"+m[1]) + m[2]
	}
	return ""
}

// twoDigits writes each number in code with two digits at least: S2E7 as
// S02E07.
func twoDigits(code string) string {
	return number.ReplaceAllStringFunc(code, func(n string) string {
		return strings.Repeat("0", max(0, 2-len(n))) + n
	})
}

// onlyVideo reports whether p is the only video in its folder in home, samples
// aside.
//
// ponytail: reads the folder again for each video in a movie folder; a search
// listing every video in Home took 40 ms on the Umbrel with it. Count each
// folder's videos once if listings slow down.
func onlyVideo(home fs.FS, p string) bool {
	if sample.MatchString(path.Base(p)) {
		return false
	}
	dir := path.Dir(p)
	entries, err := fs.ReadDir(home, dir)
	if err != nil {
		return false
	}
	n := 0
	for _, e := range entries {
		if isVideo(e) && !hidden(path.Join(dir, e.Name())) && !sample.MatchString(e.Name()) {
			n++
		}
	}
	return n == 1
}
