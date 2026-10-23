package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestServesUI(t *testing.T) {
	srv := serve(t, t.TempDir())

	page := get(t, srv.URL+"/", "text/html")
	if !strings.Contains(page, `<div id="root"></div>`) {
		t.Fatalf("page has no React root:\n%s", page)
	}
	script := regexp.MustCompile(`<script[^>]* src="(/assets/[^"]+\.js)"`).FindStringSubmatch(page)
	if script == nil {
		t.Fatalf("page loads no script:\n%s", page)
	}
	get(t, srv.URL+script[1], "javascript")
}

// Home is a temporary folder here, which the tests can write to, so it's
// found writable. CI's image check mounts Home read-only, as the package does.
func TestSaysHowItFindsItsFolders(t *testing.T) {
	home, _ := newHome(t)
	srv := serve(t, home)

	want := `[{"path":"","access":"writable","want":"read-only"},` +
		`{"path":"Downloads/metube","access":"writable","want":"writable"},` +
		`{"path":"Moments","access":"writable","want":"writable"}]`
	if got := strings.TrimSpace(get(t, srv.URL+"/api/mounts", "application/json")); got != want {
		t.Errorf("mounts:\n got %s\nwant %s", got, want)
	}

	if err := os.RemoveAll(filepath.Join(home, "Moments")); err != nil {
		t.Fatal(err)
	}
	want = `[{"path":"","access":"writable","want":"read-only"},` +
		`{"path":"Downloads/metube","access":"writable","want":"writable"},` +
		`{"path":"Moments","access":"missing","want":"writable"}]`
	if got := strings.TrimSpace(get(t, srv.URL+"/api/mounts", "application/json")); got != want {
		t.Errorf("mounts without Moments:\n got %s\nwant %s", got, want)
	}
}

// serve starts the server on the folder home, with its app data in a folder
// next to it, until the test ends.
func serve(t *testing.T, home string) *httptest.Server {
	t.Helper()
	root, err := os.OpenRoot(home)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(newHandler(root, filepath.Join(home, "../data")))
	t.Cleanup(func() {
		srv.Close()
		root.Close()
	})
	return srv
}

// get fetches url and checks it's served whole with the expected content type.
func get(t *testing.T, url, wantType string) string {
	t.Helper()
	res, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusOK {
		t.Fatalf("GET %s: %s", url, res.Status)
	}
	if ct := res.Header.Get("Content-Type"); !strings.Contains(ct, wantType) {
		t.Fatalf("GET %s: Content-Type %q, want %s", url, ct, wantType)
	}
	return string(body)
}
