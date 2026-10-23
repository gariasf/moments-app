package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"testing"
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
			`"path":"Downloads/metube/Big Buck Bunny [aqz-KE-bpKQ].webm","size":60,"sourceName":"Big Buck Bunny [aqz-KE-bpKQ]"}]}`,
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
	bunny := `{"name":"Big Buck Bunny [aqz-KE-bpKQ].webm","path":"Downloads/metube/Big Buck Bunny [aqz-KE-bpKQ].webm","size":60,"sourceName":"Big Buck Bunny [aqz-KE-bpKQ]"}`
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
		// MeTube's titles and uploads keep their file names, even alone in a folder.
		"Downloads/metube/Big Buck Bunny 60fps 4K ⧸ Official Blender Foundation Short Film.webm": "Big Buck Bunny 60fps 4K ⧸ Official Blender Foundation Short Film",
		"Uploads/IMG_4021 (2).MOV": "IMG_4021 (2)",
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
