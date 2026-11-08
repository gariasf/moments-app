package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"
)

func TestLibraryListsMomentsNewestFirst(t *testing.T) {
	home := filepath.Join(t.TempDir(), "home")
	moments := filepath.Join(home, "Moments")
	tagged := func(name, created, sourceName, length string) {
		clip(t, filepath.Join(moments, name), "-t", length, "-c:v", "libx264", "-c:a", "aac", "-movflags", "+faststart+use_metadata_tags",
			"-metadata", "creation_time="+created, "-metadata", "moments.source_name="+sourceName)
	}
	tagged("Clip (2024) · 0:12.mp4", "2026-01-03T10:00:00.000000Z", "Clip (2024)", "3")
	tagged("Severance S02E07 · 12:34.mp4", "2026-01-01T10:00:00.000000Z", "Severance S02E07", "2")
	tagged(".saving-1.mp4", "2026-01-04T10:00:00.000000Z", "Clip (2024)", "1")
	tagged("Old.mp4/Older.mp4", "2026-01-05T10:00:00.000000Z", "Clip (2024)", "1")
	clip(t, filepath.Join(moments, "Dropped in.mp4"), "-t", "1", "-c:v", "libx264", "-c:a", "aac")
	droppedAt := time.Date(2026, 1, 2, 10, 0, 0, 0, time.UTC)
	if err := os.Chtimes(filepath.Join(moments, "Dropped in.mp4"), droppedAt, droppedAt); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(moments, ".DS_Store"), []byte{0}, 0o644); err != nil {
		t.Fatal(err)
	}
	server := serve(t, home)

	want := []moment{
		{Title: "Clip (2024) · 0:12", Length: 3, SourceName: "Clip (2024)", Created: time.Date(2026, 1, 3, 10, 0, 0, 0, time.UTC)},
		{Title: "Dropped in", Length: 1, Created: droppedAt},
		{Title: "Severance S02E07 · 12:34", Length: 2, SourceName: "Severance S02E07", Created: time.Date(2026, 1, 1, 10, 0, 0, 0, time.UTC)},
	}
	checkLibrary(t, server, want)
}

func TestLibraryFollowsRenamesAndDeletionsInFiles(t *testing.T) {
	home := filepath.Join(t.TempDir(), "home")
	moments := filepath.Join(home, "Moments")
	for name, created := range map[string]string{"Kept.mp4": "2026-01-03T10:00:00Z", "Renamed.mp4": "2026-01-02T10:00:00Z", "Deleted.mp4": "2026-01-01T10:00:00Z"} {
		clip(t, filepath.Join(moments, name), "-t", "1", "-c:v", "libx264", "-c:a", "aac", "-metadata", "creation_time="+created)
	}
	server := serve(t, home)
	day := func(day int) time.Time { return time.Date(2026, 1, day, 10, 0, 0, 0, time.UTC) }
	checkLibrary(t, server, []moment{{Title: "Kept", Length: 1, Created: day(3)}, {Title: "Renamed", Length: 1, Created: day(2)}, {Title: "Deleted", Length: 1, Created: day(1)}})

	if err := os.Rename(filepath.Join(moments, "Renamed.mp4"), filepath.Join(moments, "Given a name.mp4")); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(moments, "Deleted.mp4")); err != nil {
		t.Fatal(err)
	}
	checkLibrary(t, server, []moment{{Title: "Kept", Length: 1, Created: day(3)}, {Title: "Given a name", Length: 1, Created: day(2)}})
}

func TestLibrarySaysWhereEachMomentCameFrom(t *testing.T) {
	home, _ := newHome(t)
	// Keyframes 2 s apart, and no B-frames, so a copy can end on any frame.
	clip(t, filepath.Join(home, "Videos/Clip.mkv"), "-t", "6", "-c:v", "libx264", "-bf", "0", "-g", "48", "-keyint_min", "48", "-sc_threshold", "0", "-c:a", "aac")
	saved := serve(t, home)
	postSave(t, saved, map[string]any{"path": "Videos/Clip.mkv", "start": 2.5, "end": 3.5, "title": "Clip"})
	waitForSaves(t, saved)

	var library []moment
	if err := json.Unmarshal([]byte(get(t, serve(t, home).URL+"/api/moments", "application/json")), &library); err != nil {
		t.Fatal(err)
	}
	for _, listed := range library {
		if listed.Title == "Clip" && (listed.SourcePath != "Videos/Clip.mkv" || listed.Start != 2 || math.Abs(listed.End-85.0/24) > 0.001) {
			t.Errorf("the Library lists the Moment as from %q, %v s to %v s, want from Videos/Clip.mkv, 2 s to %v s", listed.SourcePath, listed.Start, listed.End, 85.0/24)
		}
		if listed.Title == "Clip" {
			return
		}
	}
	t.Errorf("the Library lists %+v, want the Moment saved", library)
}

func TestAWarmLibraryOf50MomentsListsInUnder100ms(t *testing.T) {
	home := filepath.Join(t.TempDir(), "home")
	moments := filepath.Join(home, "Moments")
	clip(t, filepath.Join(moments, "Moment 1.mp4"), "-t", "1", "-c:v", "libx264", "-c:a", "aac")
	first := readFile(t, filepath.Join(moments, "Moment 1.mp4"))
	for i := 2; i <= 50; i++ {
		if err := os.WriteFile(filepath.Join(moments, fmt.Sprintf("Moment %d.mp4", i)), first, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	server := serve(t, home)
	listed := func() time.Duration {
		began := time.Now()
		var library []moment
		if err := json.Unmarshal([]byte(get(t, server.URL+"/api/moments", "application/json")), &library); err != nil || len(library) != 50 {
			t.Fatalf("the Library lists %d Moments, want 50 (%v)", len(library), err)
		}
		return time.Since(began)
	}

	cold := listed()
	if warm := listed(); warm >= 100*time.Millisecond {
		t.Errorf("a warm Library of 50 Moments listed in %v, want under 100ms (cold: %v)", warm, cold)
	}
}

func checkLibrary(t *testing.T, server *httptest.Server, want []moment) {
	t.Helper()
	var got []moment
	if err := json.Unmarshal([]byte(get(t, server.URL+"/api/moments", "application/json")), &got); err != nil {
		t.Fatal(err)
	}
	same := len(got) == len(want)
	for i := 0; same && i < len(got); i++ {
		same = got[i].Title == want[i].Title && got[i].SourceName == want[i].SourceName &&
			got[i].Created.Equal(want[i].Created) && math.Abs(got[i].Length-want[i].Length) < 0.1
	}
	if !same {
		t.Errorf("the Library lists\n%+v\nwant\n%+v", got, want)
	}
}

func TestPosterIsTheMomentsFirstFrame(t *testing.T) {
	home, _ := newHome(t)
	keyframesEveryTwoSeconds := []string{"-t", "6", "-g", "48", "-keyint_min", "48", "-sc_threshold", "0", "-c:a", "aac"}
	clip(t, filepath.Join(home, "Videos/Clip.mkv"), slices.Concat(keyframesEveryTwoSeconds, []string{"-c:v", "libx264", "-bf", "2"})...)
	clip(t, filepath.Join(home, "Videos/HDR10.mkv"), slices.Concat(keyframesEveryTwoSeconds, []string{"-c:v", "libx265", "-pix_fmt", "yuv420p10le",
		"-x265-params", "log-level=error:scenecut=0:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc",
		"-color_primaries", "bt2020", "-color_trc", "smpte2084", "-colorspace", "bt2020nc"})...)
	srv := serve(t, home)
	postSave(t, srv, map[string]any{"path": "Videos/Clip.mkv", "start": 2.5, "end": 4.5, "title": "Clip · 0:02"})
	postSave(t, srv, map[string]any{"path": "Videos/HDR10.mkv", "start": 2.5, "end": 4.5, "title": "HDR10 · 0:02"})
	waitForSaves(t, srv)

	for title, hdr := range map[string]bool{"Clip · 0:02": false, "HDR10 · 0:02": true} {
		file := filepath.Join(home, "Moments", title+".mp4")
		got, difference := shownFrame(t, posterOf(t, srv, title), file)
		if want := shownTimes(t, file)[0]; got != want {
			t.Errorf("%s: the poster shows the frame at %v s, want the first, at %v s", title, got, want)
		}
		// Tone-mapped HDR10 differs from its decoded frame by about 3,000, SDR by about 5.
		if tonemapped := difference > 1000; tonemapped != hdr {
			t.Errorf("%s: the poster differs from its frame by %v, want it tone-mapped: %v", title, difference, hdr)
		}
	}
}

func TestPosterComesFromTheCacheAndIsMadeAgainWhenMissing(t *testing.T) {
	home := filepath.Join(t.TempDir(), "home")
	clip(t, filepath.Join(home, "Moments/Clip.mp4"), "-t", "2", "-c:v", "libx264", "-c:a", "aac")
	srv := serve(t, home)
	first := posterOf(t, srv, "Clip")

	// With no FFmpeg to run, only the cache can answer.
	path := os.Getenv("PATH")
	t.Setenv("PATH", "")
	if again := posterOf(t, srv, "Clip"); !bytes.Equal(again, first) {
		t.Error("the poster asked for again isn't the one made first")
	}

	if err := os.RemoveAll(filepath.Join(home, "../data/cache")); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", path)
	if remade := posterOf(t, srv, "Clip"); !bytes.Equal(remade, first) {
		t.Error("the poster made again isn't the one made first")
	}
}

func TestAMomentRenamedInFilesKeepsItsPoster(t *testing.T) {
	home := filepath.Join(t.TempDir(), "home")
	moments := filepath.Join(home, "Moments")
	clip(t, filepath.Join(moments, "Clip.mp4"), "-t", "2", "-c:v", "libx264", "-c:a", "aac")
	srv := serve(t, home)
	first := posterOf(t, srv, "Clip")

	if err := os.Rename(filepath.Join(moments, "Clip.mp4"), filepath.Join(moments, "Given a name.MP4")); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", "")
	if renamed := posterOf(t, srv, "Given a name"); !bytes.Equal(renamed, first) {
		t.Error("the renamed Moment's poster isn't the one it had")
	}
	res, err := http.Get(srv.URL + "/api/moments/Clip/poster")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusNotFound {
		t.Errorf("the poster of the old title answers %s, want 404 Not Found", res.Status)
	}
}

func TestAMomentsFileAnswersRangeAndIfRangeRequests(t *testing.T) {
	home := filepath.Join(t.TempDir(), "home")
	title := "Clip · 0:12"
	file := filepath.Join(home, "Moments", title+".mp4")
	clip(t, file, "-t", "1", "-c:v", "libx264", "-c:a", "aac")
	whole := readFile(t, file)
	server := serve(t, home)
	fetchFile := func(title string, headers map[string]string) (*http.Response, []byte) {
		t.Helper()
		request, requestError := http.NewRequest(http.MethodGet, server.URL+"/api/moments/"+url.PathEscape(title)+"/file", nil)
		if requestError != nil {
			t.Fatal(requestError)
		}
		for name, value := range headers {
			request.Header.Set(name, value)
		}
		response, responseError := http.DefaultClient.Do(request)
		if responseError != nil {
			t.Fatal(responseError)
		}
		defer response.Body.Close()
		body, readError := io.ReadAll(response.Body)
		if readError != nil {
			t.Fatal(readError)
		}
		return response, body
	}

	response, body := fetchFile(title, nil)
	if response.StatusCode != http.StatusOK || !bytes.Equal(body, whole) || response.Header.Get("Content-Type") != "video/mp4" || response.Header.Get("Accept-Ranges") != "bytes" {
		t.Fatalf("the file answers %s, %s, Accept-Ranges %q, %d of %d bytes, want 200 OK, video/mp4, bytes, the whole file",
			response.Status, response.Header.Get("Content-Type"), response.Header.Get("Accept-Ranges"), len(body), len(whole))
	}
	lastModified := response.Header.Get("Last-Modified")

	response, body = fetchFile(title, map[string]string{"Range": "bytes=100-199"})
	if want := fmt.Sprintf("bytes 100-199/%d", len(whole)); response.StatusCode != http.StatusPartialContent || response.Header.Get("Content-Range") != want || !bytes.Equal(body, whole[100:200]) {
		t.Errorf("a Range answers %s, %q, %d bytes, want 206 Partial Content, %q, bytes 100 to 199", response.Status, response.Header.Get("Content-Range"), len(body), want)
	}

	response, body = fetchFile(title, map[string]string{"Range": "bytes=100-199", "If-Range": lastModified})
	if response.StatusCode != http.StatusPartialContent || !bytes.Equal(body, whole[100:200]) {
		t.Errorf("a Range If-Range the file's Last-Modified answers %s, %d bytes, want 206 Partial Content, bytes 100 to 199", response.Status, len(body))
	}

	response, body = fetchFile(title, map[string]string{"Range": "bytes=100-199", "If-Range": "Thu, 01 Jan 2004 00:00:00 GMT"})
	if response.StatusCode != http.StatusOK || !bytes.Equal(body, whole) {
		t.Errorf("a Range If-Range an older date answers %s, %d bytes, want 200 OK, the whole file", response.Status, len(body))
	}

	if missing, _ := fetchFile("Missing", nil); missing.StatusCode != http.StatusNotFound {
		t.Errorf("a missing Moment's file answers %s, want 404 Not Found", missing.Status)
	}
}

func posterOf(t *testing.T, srv *httptest.Server, title string) []byte {
	t.Helper()
	return []byte(get(t, srv.URL+"/api/moments/"+url.PathEscape(title)+"/poster", "image/jpeg"))
}
