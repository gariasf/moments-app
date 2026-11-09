package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// newHome makes a Home laid out like the real one behind the container's
// mounts, with Jellyfin's folders and MeTube's under Downloads, and a folder
// next to it that's outside Home.
func newHome(t *testing.T) (home, outside string) {
	t.Helper()
	dir := t.TempDir()
	home, outside = filepath.Join(dir, "home"), filepath.Join(dir, "outside")
	for name, size := range map[string]int{
		"home/Downloads/Movies/Tears of Steel (2012)/Tears.of.Steel.2012.1080p.BluRay.x264.mkv":   2012,
		"home/Downloads/Movies/Tears of Steel (2012)/Tears.of.Steel.2012.1080p.BluRay.x264.nfo":   1,
		"home/Downloads/Movies/Tears of Steel (2012)/poster.jpg":                                  1,
		"home/Downloads/Movies/Tears of Steel (2012)/._Tears.of.Steel.2012.1080p.BluRay.x264.mkv": 1,
		"home/Downloads/TV Shows/Pioneer One/Season 2/Pioneer.One.S02E07.2160p.WEB-DL.mkv":        207,
		"home/Downloads/TV Shows/Pioneer One/Season 2/Pioneer.One.S02E07.2160p.WEB-DL.srt":        1,
		"home/Downloads/metube/Big Buck Bunny [aqz-KE-bpKQ].webm":                                 60,
		"home/Downloads/metube/.metube/tmp/Big Buck Bunny [aqz-KE-bpKQ].webm":                     1,
		"home/Videos/Holiday.MOV":                 4,
		"home/.DS_Store":                          1,
		"home/notes.txt":                          1,
		"home/Moments/Tears of Steel (2012).mp4":  1,
		"outside/Tears.of.Steel.2012.Remux.mkv":   1,
		"outside/Movies/Sintel (2010)/Sintel.mkv": 1,
	} {
		p := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, make([]byte, size), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// Links out of Home: a relative one and an absolute one.
	for link, target := range map[string]string{
		"home/Downloads/Movies/Escape": "../../../outside",
		"home/Downloads/Outside":       outside,
	} {
		if err := os.Symlink(target, filepath.Join(dir, link)); err != nil {
			t.Fatal(err)
		}
	}
	return home, outside
}

// sources asks the server for the Sources the page would see, and returns its JSON.
func sources(t *testing.T, srv *httptest.Server, query url.Values) string {
	t.Helper()
	return strings.TrimSpace(get(t, srv.URL+"/api/sources?"+query.Encode(), "application/json"))
}

func TestListingShowsFoldersAndVideosWithSizes(t *testing.T) {
	home, _ := newHome(t)
	srv := serve(t, home)

	for path, want := range map[string]string{
		"": `{"folders":[{"name":"Downloads","path":"Downloads"},{"name":"Videos","path":"Videos"}],"videos":[]}`,
		"Downloads": `{"folders":[{"name":"Movies","path":"Downloads/Movies"},{"name":"TV Shows","path":"Downloads/TV Shows"},` +
			`{"name":"metube","path":"Downloads/metube"}],"videos":[]}`,
		"Downloads/Movies/Tears of Steel (2012)": `{"folders":[],"videos":[{"name":"Tears.of.Steel.2012.1080p.BluRay.x264.mkv",` +
			`"path":"Downloads/Movies/Tears of Steel (2012)/Tears.of.Steel.2012.1080p.BluRay.x264.mkv","size":2012,"sourceName":"Tears of Steel (2012)"}]}`,
		"Downloads/metube": `{"folders":[],"videos":[{"name":"Big Buck Bunny [aqz-KE-bpKQ].webm",` +
			`"path":"Downloads/metube/Big Buck Bunny [aqz-KE-bpKQ].webm","size":60,"sourceName":"Big Buck Bunny [aqz-KE-bpKQ]","deletable":true}]}`,
		"Videos": `{"folders":[],"videos":[{"name":"Holiday.MOV","path":"Videos/Holiday.MOV","size":4,"sourceName":"Holiday"}]}`,
	} {
		if got := sources(t, srv, url.Values{"path": {path}}); got != want {
			t.Errorf("listing %q:\n got %s\nwant %s", path, got, want)
		}
	}
}

func TestSearchFindsVideosByFileOrFolderNameIgnoringCase(t *testing.T) {
	home, _ := newHome(t)
	srv := serve(t, home)

	tears := `{"name":"Tears.of.Steel.2012.1080p.BluRay.x264.mkv",` +
		`"path":"Downloads/Movies/Tears of Steel (2012)/Tears.of.Steel.2012.1080p.BluRay.x264.mkv","size":2012,"sourceName":"Tears of Steel (2012)"}`
	pioneer := `{"name":"Pioneer.One.S02E07.2160p.WEB-DL.mkv",` +
		`"path":"Downloads/TV Shows/Pioneer One/Season 2/Pioneer.One.S02E07.2160p.WEB-DL.mkv","size":207,"sourceName":"Pioneer One S02E07"}`
	bunny := `{"name":"Big Buck Bunny [aqz-KE-bpKQ].webm","path":"Downloads/metube/Big Buck Bunny [aqz-KE-bpKQ].webm","size":60,"sourceName":"Big Buck Bunny [aqz-KE-bpKQ]","deletable":true}`
	for q, videos := range map[string]string{
		"TEARS of steel": tears,                 // every word, across the dots
		"tv shows":       pioneer,               // a folder's name
		"s02e07":         pioneer,               // a file's name
		"bunny":          bunny,                 // not the one in MeTube's dot-folder
		"MKV":            tears + "," + pioneer, // not the dotfile
		"sintel":         "",                    // only outside Home, through a link
	} {
		want := `{"folders":[],"videos":[` + videos + `]}`
		if got := sources(t, srv, url.Values{"q": {q}}); got != want {
			t.Errorf("search %q:\n got %s\nwant %s", q, got, want)
		}
	}
}

func TestNamesSourcesFromTheirFolders(t *testing.T) {
	// Paths shaped like the Sources in Home, each with the name the Trimmer shows.
	names := map[string]string{
		// A movie folder's one video takes its name, up to the year.
		"Downloads/Movies/Sintel (2010)/Sintel.2010.2160p.4K.BluRay.x265.10bit.AAC5.1.mkv":         "Sintel (2010)",
		"Downloads/Movies/Tears of Steel (2012) [1080p]/Tears.of.Steel.2012.1080p.BluRay.x264.mp4": "Tears of Steel (2012)",
		// Two cuts in one folder, and folders without a year, such as extras' or
		// a media server's copies, keep their file names.
		"Downloads/Movies/Spring (2019)/Spring.2019.Theatrical.1080p.mkv":                  "Spring.2019.Theatrical.1080p",
		"Downloads/Movies/Spring (2019)/Spring.2019.Extended.1080p.mkv":                    "Spring.2019.Extended.1080p",
		"Downloads/Movies/Tears of Steel (2012) [1080p]/Featurettes/Behind the Scenes.mkv": "Behind the Scenes",
		"Downloads/Movies/Sintel (2010)/Plex Versions/Optimized for TV/Sintel (2010).mp4":  "Sintel (2010)",
		// A release's sample doesn't count, and keeps its file name.
		"Downloads/Movies/Elephants Dream (2006)/Elephants.Dream.2006.1080p.BluRay.x264.mkv":         "Elephants Dream (2006)",
		"Downloads/Movies/Elephants Dream (2006)/sample-Elephants.Dream.2006.1080p.BluRay.x264.mkv":  "sample-Elephants.Dream.2006.1080p.BluRay.x264",
		"Downloads/Movies/Cosmos Laundromat (2015)/Cosmos.Laundromat.2015.1080p.WEB.x264.mkv":        "Cosmos Laundromat (2015)",
		"Downloads/Movies/Cosmos Laundromat (2015)/Cosmos.Laundromat.2015.1080p.WEB.x264.Sample.mkv": "Cosmos.Laundromat.2015.1080p.WEB.x264.Sample",
		"Downloads/Movies/Sintel (2010)/Sample/sintel.2010.2160p.bluray.x265.sample.mkv":             "sintel.2010.2160p.bluray.x265.sample",
		"Downloads/Movies/Sample Size (2016)/Sample.Size.2016.1080p.WEB.mkv":                         "Sample Size (2016)",
		// In a season folder, the show and the episode code.
		"Downloads/TV Shows/Pioneer One/Season 1/Pioneer.One.S01E01.Earthfall.1080p.WEB-DL.DDP5.1.H.264.mkv": "Pioneer One S01E01",
		"Downloads/TV Shows/Pioneer One/Season 1/Pioneer One - S01 E02 - Lights (1080p - WEB-DL).mp4":        "Pioneer One S01E02",
		"Downloads/TV Shows/Pioneer One/S02/S02E01.mkv":                                                      "Pioneer One S02E01",
		"Downloads/TV Shows/Pioneer One/S02/Pioneer.One.S02E02E03.720p.mp4":                                  "Pioneer One S02E02E03",
		"Downloads/TV Shows/Pioneer One/S02/Pioneer_One_s02e04_Signals.mkv":                                  "Pioneer One S02E04",
		"Downloads/TV Shows/Pioneer One/S02/Pioneer.One.s2e5.mkv":                                            "Pioneer One S02E05",
		"Downloads/TV Shows/Pioneer One/Season 1/Behind Pioneer One.mkv":                                     "Behind Pioneer One",
		"Downloads/TV Shows/Pioneer One/Season 1/Op-Ed Interview.mkv":                                        "Op-Ed Interview",
		// An episode numbered alone takes its season from the folder.
		"Downloads/TV Shows/Hoshi no Uta/S01/[Subs] Hoshi no Uta 1080p BD HEVC Ep 01 [Encoder].mkv":                "Hoshi no Uta S01E01",
		"Downloads/TV Shows/Hoshi no Uta/S01/Hoshi_no_Uta_Ep02_Moonlight_[1080p,BluRay,x264,flac].mkv":             "Hoshi no Uta S01E02",
		"Downloads/TV Shows/Hoshi no Uta/S01/[Subs]Hoshi.no.Uta.EP3(BD.1080p.AAC)[5E6F7A8B].mkv":                   "Hoshi no Uta S01E03",
		"Downloads/TV Shows/Hoshi no Uta/S01/[Subs]_Hoshi_no_Uta_-_Session_04_-_Night_Train_[720p]_[1A2B3C4D].mkv": "Hoshi no Uta S01E04",
		"Downloads/TV Shows/Hoshi no Uta/S01/[Subs] Hoshi no Uta 1080p BD HEVC Ep 11.5 [Encoder].mkv":              "Hoshi no Uta S01E11.5",
		"Downloads/TV Shows/Hoshi no Uta/Season 2/Hoshi no Uta - Ep 1.mkv":                                         "Hoshi no Uta S02E01",
		"Downloads/TV Shows/Hoshi no Uta/Season 2/Hoshi.no.Uta.Ep.02.2019.1080p.WEB.mkv":                           "Hoshi no Uta S02E02",
		// The creditless openings and endings anime releases add, and a season's
		// bonus folder, which isn't a season folder.
		"Downloads/TV Shows/Hoshi no Uta/S01/[Subs] Hoshi no Uta 1080p BD HEVC NCOP1 [Encoder].mkv": "Hoshi no Uta NCOP1",
		"Downloads/TV Shows/Hoshi no Uta/S01/Hoshi_no_Uta_ED_[1080p,BluRay,x264,flac].mkv":          "Hoshi no Uta ED",
		"Downloads/TV Shows/Hoshi no Uta/S01/[Subs] Hoshi no Uta - NCOP 2 [1080p].mkv":              "Hoshi no Uta NCOP2",
		"Downloads/TV Shows/Hoshi no Uta/S01/[Subs] Hoshi no Uta - NCED (Ep 12) [1080p].mkv":        "Hoshi no Uta NCED",
		"Downloads/TV Shows/Hoshi no Uta/S01/Bonus/Clean Credits.mkv":                               "Clean Credits",
		// MeTube's titles keep their file names, even alone in a folder.
		"Downloads/metube/Big Buck Bunny 60fps 4K ⧸ Official Blender Foundation Short Film.webm": "Big Buck Bunny 60fps 4K ⧸ Official Blender Foundation Short Film",
	}
	home := t.TempDir()
	for p := range names {
		file := filepath.Join(home, p)
		if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	srv := serve(t, home)

	for p, want := range names {
		var l struct {
			Videos []struct{ Path, SourceName string }
		}
		if err := json.Unmarshal([]byte(sources(t, srv, url.Values{"path": {path.Dir(p)}})), &l); err != nil {
			t.Fatal(err)
		}
		got := "(not listed)"
		for _, v := range l.Videos {
			if v.Path == p {
				got = v.SourceName
			}
		}
		if got != want {
			t.Errorf("%s:\n got %q\nwant %q", p, got, want)
		}
	}
}

func TestMomentsAndDotFoldersNeverShow(t *testing.T) {
	home, _ := newHome(t)
	srv := serve(t, home)

	for _, query := range []url.Values{{"path": {""}}, {"q": {"tears"}}, {"q": {"moments"}}} {
		if got := sources(t, srv, query); strings.Contains(got, "Moments") {
			t.Errorf("%s shows the Moments folder: %s", query.Encode(), got)
		}
	}
	for _, path := range []string{"Moments", "Downloads/../Moments", "Downloads/metube/.metube", "Downloads/metube/.metube/tmp"} {
		if got := status(t, srv, "/api/sources", path); got != http.StatusNotFound {
			t.Errorf("listing %q: %d, want 404", path, got)
		}
	}
}

func TestRefusesPathsOutsideHome(t *testing.T) {
	home, outside := newHome(t)
	srv := serve(t, home)

	for _, path := range []string{
		"..", "../outside", "Downloads/../..", "Downloads/../../outside", // through ..
		outside, "/", // as an absolute path
		"Downloads/Movies/Escape", "Downloads/Outside", "Downloads/Outside/Movies", // through a link
	} {
		if got := status(t, srv, "/api/sources", path); got != http.StatusNotFound {
			t.Errorf("listing %q: %d, want 404", path, got)
		}
	}
}

func TestOpensNoSourceOutsideHome(t *testing.T) {
	home, outside := newHome(t)
	srv := serve(t, home)

	for _, path := range []string{
		"../outside/Tears.of.Steel.2012.Remux.mkv", filepath.Join(outside, "Tears.of.Steel.2012.Remux.mkv"), // through .. and as an absolute path
		"Downloads/Movies/Escape/Tears.of.Steel.2012.Remux.mkv", "Downloads/Outside/Tears.of.Steel.2012.Remux.mkv", // through a link
		"Moments/Tears of Steel (2012).mp4", "Downloads/metube/.metube/tmp/Big Buck Bunny [aqz-KE-bpKQ].webm", // hidden
		"Downloads/Movies", // a folder
	} {
		for _, endpoint := range []string{"/api/source", "/api/source/stream"} {
			if got := status(t, srv, endpoint, path); got != http.StatusNotFound {
				t.Errorf("%s for %q: %d, want 404", endpoint, path, got)
			}
		}
	}
}

// status asks the server's endpoint about path, and returns the status.
func status(t *testing.T, srv *httptest.Server, endpoint, path string) int {
	t.Helper()
	res, err := http.Get(srv.URL + endpoint + "?" + url.Values{"path": {path}}.Encode())
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	return res.StatusCode
}

func TestDeletesOnlyMeTubeDownloadsAndUploads(t *testing.T) {
	home, outside := newHome(t)
	uploads := filepath.Join(home, "../data/uploads")
	tears := "Downloads/Movies/Tears of Steel (2012)/Tears.of.Steel.2012.1080p.BluRay.x264.mkv"
	for file, contents := range map[string]string{
		filepath.Join(uploads, "IMG_4021.MOV"): "upload",
		filepath.Join(uploads, "notes.txt"):    "notes",
	} {
		if makeError := os.MkdirAll(filepath.Dir(file), 0o755); makeError != nil {
			t.Fatal(makeError)
		}
		if writeError := os.WriteFile(file, []byte(contents), 0o644); writeError != nil {
			t.Fatal(writeError)
		}
	}
	for link, target := range map[string]string{
		filepath.Join(home, "Downloads/metube/Movies"):    "../Movies",
		filepath.Join(home, "Downloads/metube/Tears.mkv"): "../Movies/Tears of Steel (2012)/Tears.of.Steel.2012.1080p.BluRay.x264.mkv",
		filepath.Join(uploads, "Holiday.MOV"):             filepath.Join(home, "Videos/Holiday.MOV"),
		filepath.Join(uploads, "Home"):                    home,
		filepath.Join(home, "Downloads/metube/Elsewhere"): outside,
		filepath.Join(home, "Downloads/metube/Remux.mkv"): filepath.Join(outside, "Tears.of.Steel.2012.Remux.mkv"),
	} {
		if linkError := os.Symlink(target, link); linkError != nil {
			t.Fatal(linkError)
		}
	}
	server := serve(t, home)

	for _, path := range []string{
		tears, "Videos/Holiday.MOV", "Moments/Tears of Steel (2012).mp4",
		"Downloads/metube/../Movies/Tears of Steel (2012)/Tears.of.Steel.2012.1080p.BluRay.x264.mkv", "Uploads/../../home/Videos/Holiday.MOV",
		"Downloads/metube/Movies/Tears of Steel (2012)/Tears.of.Steel.2012.1080p.BluRay.x264.mkv", "Downloads/metube/Tears.mkv",
		"Uploads/Holiday.MOV", "Uploads/Home/Videos/Holiday.MOV",
		"Downloads/metube/Elsewhere/Tears.of.Steel.2012.Remux.mkv", "Downloads/metube/Remux.mkv",
		"../outside/Tears.of.Steel.2012.Remux.mkv", filepath.Join(outside, "Tears.of.Steel.2012.Remux.mkv"),
		"Downloads/metube/.metube/tmp/Big Buck Bunny [aqz-KE-bpKQ].webm",
		"Downloads/metube", "Uploads/notes.txt",
		"Downloads/metube/./Big Buck Bunny [aqz-KE-bpKQ].webm",
	} {
		if got := askToDelete(t, server, path); got != http.StatusForbidden {
			t.Errorf("deleting %q: %d, want 403", path, got)
		}
	}
	for _, file := range []string{
		filepath.Join(home, tears), filepath.Join(home, "Videos/Holiday.MOV"), filepath.Join(home, "Moments/Tears of Steel (2012).mp4"),
		filepath.Join(outside, "Tears.of.Steel.2012.Remux.mkv"), filepath.Join(home, "Downloads/metube/.metube/tmp/Big Buck Bunny [aqz-KE-bpKQ].webm"),
		filepath.Join(home, "Downloads/metube/Tears.mkv"), filepath.Join(uploads, "Holiday.MOV"), filepath.Join(uploads, "notes.txt"),
	} {
		if _, lstatError := os.Lstat(file); lstatError != nil {
			t.Errorf("a refused delete removed %s: %v", file, lstatError)
		}
	}

	for path, file := range map[string]string{
		"Downloads/metube/Big Buck Bunny [aqz-KE-bpKQ].webm": filepath.Join(home, "Downloads/metube/Big Buck Bunny [aqz-KE-bpKQ].webm"),
		"Uploads/IMG_4021.MOV":                               filepath.Join(uploads, "IMG_4021.MOV"),
	} {
		if got := askToDelete(t, server, path); got != http.StatusNoContent {
			t.Errorf("deleting %q: %d, want 204", path, got)
		}
		if _, lstatError := os.Lstat(file); !os.IsNotExist(lstatError) {
			t.Errorf("deleting %q left %s: %v", path, file, lstatError)
		}
	}
	if got := askToDelete(t, server, "Downloads/metube/Big Buck Bunny [aqz-KE-bpKQ].webm"); got != http.StatusNotFound {
		t.Errorf("deleting a Source already gone: %d, want 404", got)
	}

	metube := filepath.Join(home, "Downloads/metube")
	if removeError := os.RemoveAll(metube); removeError != nil {
		t.Fatal(removeError)
	}
	if linkError := os.Symlink("Movies", metube); linkError != nil {
		t.Fatal(linkError)
	}
	if got := askToDelete(t, server, "Downloads/metube/Tears of Steel (2012)/Tears.of.Steel.2012.1080p.BluRay.x264.mkv"); got != http.StatusForbidden {
		t.Errorf("deleting through a metube folder that links to Movies: %d, want 403", got)
	}
	if _, lstatError := os.Lstat(filepath.Join(home, tears)); lstatError != nil {
		t.Errorf("a refused delete removed %s: %v", tears, lstatError)
	}
}

func TestListingsMarkTheSourcesMomentsMayDelete(t *testing.T) {
	home, _ := newHome(t)
	if linkError := os.Symlink("../Movies", filepath.Join(home, "Downloads/metube/Movies")); linkError != nil {
		t.Fatal(linkError)
	}
	server := serve(t, home)

	for _, query := range []url.Values{
		{"path": {"Downloads/metube/Movies/Tears of Steel (2012)"}}, {"q": {"tears"}}, {"path": {"Videos"}},
	} {
		if got := sources(t, server, query); strings.Contains(got, "deletable") {
			t.Errorf("%s marks a Source outside metube deletable: %s", query.Encode(), got)
		}
	}
	for _, query := range []url.Values{{"path": {"Downloads/metube"}}, {"q": {"bunny"}}} {
		if got := sources(t, server, query); !strings.Contains(got, `"deletable":true`) {
			t.Errorf("%s doesn't mark the MeTube download deletable: %s", query.Encode(), got)
		}
	}
}

func TestRefusesToDeleteASourceASaveNeeds(t *testing.T) {
	home, _ := newHome(t)
	slowSource(t, home)
	slow, clipped := "Downloads/metube/Slow.mkv", "Downloads/metube/Clip.mkv"
	if renameError := os.Rename(filepath.Join(home, "Videos/Slow.mkv"), filepath.Join(home, slow)); renameError != nil {
		t.Fatal(renameError)
	}
	linked := "Downloads/metube/Linked.mkv"
	for _, path := range []string{clipped, linked} {
		clip(t, filepath.Join(home, path), "-t", "4", "-c:v", "libx264", "-g", "48", "-c:a", "aac")
	}
	if linkError := os.Symlink("../Downloads/metube/Linked.mkv", filepath.Join(home, "Videos/Linked.mkv")); linkError != nil {
		t.Fatal(linkError)
	}
	failChecks(t).Store(true)
	server := serve(t, home)

	postSave(t, server, map[string]any{"path": slow, "start": 0, "end": 59, "title": "Slow"})
	postSave(t, server, map[string]any{"path": clipped, "start": 1, "end": 3, "title": "Clip"})
	postSave(t, server, map[string]any{"path": "Videos/Linked.mkv", "start": 1, "end": 3, "title": "Linked"})
	for _, path := range []string{slow, clipped, linked} {
		if got := askToDelete(t, server, path); got != http.StatusConflict {
			t.Errorf("deleting %q while a Save from it is on its way: %d, want 409", path, got)
		}
	}
	failed := waitForFailure(t, server, "Clip")
	waitForFailure(t, server, "Linked")
	if got := askToDelete(t, server, linked); got != http.StatusConflict {
		t.Errorf("deleting %q while a Save from it through a link has failed: %d, want 409", linked, got)
	}
	if got := askToDelete(t, server, clipped); got != http.StatusConflict {
		t.Errorf("deleting %q while a Save from it has failed: %d, want 409", clipped, got)
	}
	if got := askSave(t, server, http.MethodDelete, failed.ID, ""); got != http.StatusNoContent {
		t.Fatalf("dismissing the failed Save: %d", got)
	}
	if got := askToDelete(t, server, clipped); got != http.StatusNoContent {
		t.Errorf("deleting %q once its Save is dismissed: %d, want 204", clipped, got)
	}
}

func askToDelete(t *testing.T, server *httptest.Server, path string) int {
	t.Helper()
	request, requestError := http.NewRequest(http.MethodDelete, server.URL+"/api/sources?"+url.Values{"path": {path}}.Encode(), nil)
	if requestError != nil {
		t.Fatal(requestError)
	}
	response, responseError := http.DefaultClient.Do(request)
	if responseError != nil {
		t.Fatal(responseError)
	}
	response.Body.Close()
	return response.StatusCode
}

func TestUploadsLandInUploadsUnderTheirNames(t *testing.T) {
	home, _ := newHome(t)
	shadowed := filepath.Join(home, "Uploads/IMG_4021.MOV")
	if makeError := os.MkdirAll(filepath.Dir(shadowed), 0o755); makeError != nil {
		t.Fatal(makeError)
	}
	if writeError := os.WriteFile(shadowed, []byte("home"), 0o644); writeError != nil {
		t.Fatal(writeError)
	}
	server := serve(t, home)

	for _, want := range []string{"Uploads/IMG_4021.MOV", "Uploads/IMG_4021 (2).MOV", "Uploads/IMG_4021 (3).MOV"} {
		if got := upload(t, server, "IMG_4021.MOV", "video", http.StatusCreated); !strings.Contains(got, `"path":"`+want+`"`) {
			t.Errorf("uploading IMG_4021.MOV: %s, want it at %s", got, want)
		}
	}
	want := `{"folders":[],"videos":[` +
		`{"name":"IMG_4021 (2).MOV","path":"Uploads/IMG_4021 (2).MOV","size":5,"sourceName":"IMG_4021 (2)","deletable":true},` +
		`{"name":"IMG_4021 (3).MOV","path":"Uploads/IMG_4021 (3).MOV","size":5,"sourceName":"IMG_4021 (3)","deletable":true},` +
		`{"name":"IMG_4021.MOV","path":"Uploads/IMG_4021.MOV","size":5,"sourceName":"IMG_4021","deletable":true}]}`
	if got := sources(t, server, url.Values{"path": {"Uploads"}}); got != want {
		t.Errorf("listing Uploads:\n got %s\nwant %s", got, want)
	}
	if got := sources(t, server, url.Values{"q": {"img (2)"}}); !strings.Contains(got, `"path":"Uploads/IMG_4021 (2).MOV"`) || strings.Contains(got, `"path":"Uploads/IMG_4021.MOV"`) {
		t.Errorf("searching for img (2): %s, want only Uploads/IMG_4021 (2).MOV", got)
	}
	if got := sources(t, server, url.Values{"q": {"img"}}) + sources(t, server, url.Values{"path": {""}}); strings.Contains(got, `"size":4`) || strings.Contains(got, `"path":"Uploads"`) {
		t.Errorf("Home's own Uploads folder shows: %s", got)
	}

	clipped := filepath.Join(t.TempDir(), "Clip.mkv")
	clip(t, clipped, "-t", "2", "-c:v", "libx264", "-c:a", "aac")
	video, readError := os.ReadFile(clipped)
	if readError != nil {
		t.Fatal(readError)
	}
	upload(t, server, "Clip.mkv", string(video), http.StatusCreated)
	get(t, server.URL+"/api/source?"+url.Values{"path": {"Uploads/Clip.mkv"}}.Encode(), "application/json")

	for _, name := range []string{"", "../Clip.mkv", "Videos/Clip.mkv", ".Clip.mkv", "notes.txt"} {
		upload(t, server, name, "video", http.StatusBadRequest)
	}
	if entries, _ := os.ReadDir(filepath.Join(home, "../data/uploads")); len(entries) != 4 {
		t.Errorf("Uploads holds %d files after the refused uploads, want 4", len(entries))
	}
}

func upload(t *testing.T, server *httptest.Server, name, body string, wantStatus int) string {
	t.Helper()
	response, postError := http.Post(server.URL+"/api/uploads?"+url.Values{"name": {name}}.Encode(), "video/quicktime", strings.NewReader(body))
	if postError != nil {
		t.Fatal(postError)
	}
	defer response.Body.Close()
	answer, _ := io.ReadAll(response.Body)
	if response.StatusCode != wantStatus {
		t.Errorf("uploading %q: %s %s, want %d", name, response.Status, answer, wantStatus)
	}
	return string(answer)
}

func TestAnUploadCutOffLeavesNothingBehind(t *testing.T) {
	home, _ := newHome(t)
	server := serve(t, home)
	uploads := filepath.Join(home, "../data/uploads")

	connection, dialError := net.Dial("tcp", server.Listener.Addr().String())
	if dialError != nil {
		t.Fatal(dialError)
	}
	fmt.Fprintf(connection, "POST /api/uploads?name=Holiday.MOV HTTP/1.1\r\nHost: moments\r\nContent-Length: 1000000\r\n\r\n%s", strings.Repeat("v", 1000))
	uploadsHold := func(want int) bool {
		entries, _ := os.ReadDir(uploads)
		return len(entries) == want
	}
	for deadline := time.Now().Add(10 * time.Second); !uploadsHold(1); time.Sleep(10 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("the upload never reached Uploads")
		}
	}
	connection.Close()
	for deadline := time.Now().Add(10 * time.Second); !uploadsHold(0); time.Sleep(10 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("the upload cut off stayed in Uploads")
		}
	}
}

func TestStartupRemovesUploadsACrashCutOff(t *testing.T) {
	home, _ := newHome(t)
	uploads := filepath.Join(home, "../data/uploads")
	if makeError := os.MkdirAll(uploads, 0o755); makeError != nil {
		t.Fatal(makeError)
	}
	for _, name := range []string{".uploading-123", "IMG_4021.MOV", ".DS_Store"} {
		if writeError := os.WriteFile(filepath.Join(uploads, name), []byte("video"), 0o644); writeError != nil {
			t.Fatal(writeError)
		}
	}
	serve(t, home)

	if _, statError := os.Lstat(filepath.Join(uploads, ".uploading-123")); !os.IsNotExist(statError) {
		t.Errorf("the upload a crash cut off is still in Uploads: %v", statError)
	}
	for _, name := range []string{"IMG_4021.MOV", ".DS_Store"} {
		if _, statError := os.Lstat(filepath.Join(uploads, name)); statError != nil {
			t.Errorf("startup removed %s: %v", name, statError)
		}
	}
}
