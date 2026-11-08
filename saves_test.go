package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"math"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

func TestSaveCutsTheMarkedMoment(t *testing.T) {
	home, _ := newHome(t)
	subtitles := filepath.Join(t.TempDir(), "subtitles.srt")
	if err := os.WriteFile(subtitles, []byte("1\n00:00:01,000 --> 00:00:03,000\nHello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Keyframes 10 s apart, as most Sources in Home have them, and B-frames,
	// which show out of their decode order. The Matroska Source starts 10 s
	// in, as some remuxes do. x265's open GOP gives keyframes leading frames,
	// decoded after them but shown before. AV1 has no B-frames. The tracks'
	// default is the first, and the second, AC-3, is chosen. The silent MP4 has
	// a camera's timecode.
	every10s := []string{"-t", "25", "-g", "240", "-keyint_min", "240", "-sc_threshold", "0"}
	h264 := slices.Concat(every10s, []string{"-c:v", "libx264", "-bf", "3"})
	sources := map[string]struct {
		args       []string
		start, end float64 // the marks, in the Source's own time, off its keyframes and clean ends
		audio      any     // the audio track chosen, counted from 0, or nil for the default
		carries    string  // the Moment's streams, as carried describes them
		copies     bool    // the Source's own audio packets
	}{
		"Downloads/Movies/Late (2024)/Late.mkv": {slices.Concat(h264, []string{"-c:a", "aac", "-output_ts_offset", "10"}), 23.7, 31.3, nil, "avc1 8, mp4a mono", true},
		"Downloads/Movies/Clip (2024)/Clip.mp4": {slices.Concat(h264, []string{"-c:a", "aac"}), 13.7, 21.3, nil, "avc1 8, mp4a mono", true},
		"Videos/Open GOP.mkv": {[]string{"-t", "8", "-c:v", "libx265", "-x265-params", "log-level=error:keyint=48:min-keyint=48:scenecut=0:open-gop=1",
			"-c:a", "aac"}, 4.5, 7.3, nil, "hvc1, mp4a mono", true},
		"Downloads/metube/AV1 [aqz-KE-bpKQ].webm": {[]string{"-t", "8", "-c:v", "libsvtav1", "-preset", "12", "-g", "48", "-c:a", "libopus"}, 2.5, 6.3, nil, "av01, Opus mono", true},
		"Videos/Tracks.mkv": {slices.Concat([]string{"-i", subtitles}, h264, []string{"-map", "0:v", "-map", "1:a", "-map", "1:a", "-map", "2:s",
			"-c:a:0", "aac", "-c:a:1", "ac3", "-ch_layout:a:1", "5.1(side)", "-c:s", "srt"}), 13.7, 21.3, 1, "avc1 8, mp4a 5.1", false},
		"Videos/Silent.mp4": {slices.Concat(h264, []string{"-an", "-timecode", "01:00:00:00"}), 13.7, 21.3, nil, "avc1 8", false},
	}
	for name, s := range sources {
		clip(t, filepath.Join(home, name), s.args...)
	}
	srv := serve(t, home)

	for name, s := range sources {
		postSave(t, srv, map[string]any{"path": name, "start": s.start, "end": s.end, "audio": s.audio, "title": filepath.Base(name)})
	}
	waitForSaves(t, srv)

	for name, want := range sources {
		src, moment := filepath.Join(home, name), filepath.Join(home, "Moments", filepath.Base(name)+".mp4")
		// The keyframe at or before the start, and the clean end at or before the end.
		start, end := atOrBefore(keyframeTimes(t, src), want.start), atOrBefore(cleanEnds(t, src), want.end)
		if got := firstPacket(t, moment); got != "0.000000,K__" {
			t.Errorf("%s: the Moment's first video packet is %s, want a keyframe at 0: 0.000000,K__", name, got)
		}
		// Every frame from the start through the end shows, at its time from the start.
		var wantShown []float64
		for _, pts := range between(packetTimes(t, src, "V"), start, end) {
			wantShown = append(wantShown, pts-start)
		}
		if got := shownTimes(t, moment); !slices.EqualFunc(got, wantShown, func(a, b float64) bool { return math.Abs(a-b) <= 0.001 }) {
			t.Errorf("%s from %v s through %v s: the Moment shows %s, want %s", name, start, end, brief(got), brief(wantShown))
		}
		if got := carried(t, moment); got != want.carries {
			t.Errorf("%s: the Moment carries %s, want %s", name, got, want.carries)
		}
		if !run(packetHashes(t, moment, "V"), packetHashes(t, src, "V")) {
			t.Errorf("%s: the Moment's video packets aren't the Source's own", name)
		}
		// Copied, the audio's packets are the Source's own, the first at its time
		// there from the start. These copy the default track, the first, which
		// decodedTimes reads.
		if want.copies {
			hashes, copied := packetHashes(t, src, fmt.Sprint("a:", chosen(want.audio))), packetHashes(t, moment, "a")
			if !run(copied, hashes) {
				t.Errorf("%s: the Moment's audio packets aren't the Source's own", name)
			} else if got, want := decodedTimes(t, moment, "a")[0], decodedTimes(t, src, "a")[slices.Index(hashes, copied[0])]-start; math.Abs(got-want) > 0.001 {
				t.Errorf("%s: the Moment's first audio packet is at %v s, want %v s, as in the Source from the start", name, got, want)
			}
		}
		if boxes := boxTypes(readFile(t, moment)); slices.Index(boxes, "moov") > slices.Index(boxes, "mdat") {
			t.Errorf("%s: the Moment's boxes are %s, want its index, the moov, before its media", name, strings.Join(boxes, " "))
		}
		// Within an AAC frame of 1,024 samples at 48 kHz.
		if video, audio := streamEnd(t, moment, "V"), streamEnd(t, moment, "a"); strings.Contains(want.carries, ", ") && math.Abs(audio-video) > 1024.0/48000 {
			t.Errorf("%s: the Moment's audio ends at %v s, want within an AAC frame of its video's end, %v s", name, audio, video)
		}
	}
}

func TestSaveNamesTheMomentAfterItsTitle(t *testing.T) {
	home, _ := newHome(t)
	// Keyframes 2 s apart, so a start at 2.5 s is on the one at 2 s. It's the
	// one video in its movie folder, which names it.
	clip(t, filepath.Join(home, "Downloads/Movies/Clip (2024)/Clip.mkv"), "-t", "4", "-c:v", "libx264", "-g", "48", "-keyint_min", "48", "-sc_threshold", "0", "-c:a", "aac")
	srv := serve(t, home)
	moments := filepath.Join(home, "Moments")
	before := names(t, moments) // a Moment of Tears of Steel (newHome)

	long := strings.Repeat("Ö", 200) // 400 bytes, past the 255 of a file's name
	for _, title := range []string{"AC/DC\tLive", "..Hidden", "", " . ", "Same", "Same", "Same", "Tears of Steel (2012)", long, long} {
		postSave(t, srv, map[string]any{"path": "Downloads/Movies/Clip (2024)/Clip.mkv", "start": 2.5, "end": 3.5, "title": title})
	}
	waitForSaves(t, srv)

	// / replaced and a tab a space; leading dots and spaces dropped; an empty
	// title, or one that's empty without them, the Source's name and the start;
	// a long one cut to fit, between characters, with room for " (2)" on a
	// clash.
	want := append(before, "AC⧸DC Live.mp4", "Hidden.mp4", "Clip (2024) · 0:02.mp4", "Clip (2024) · 0:02 (2).mp4",
		"Same.mp4", "Same (2).mp4", "Same (3).mp4", "Tears of Steel (2012) (2).mp4",
		strings.Repeat("Ö", 125)+".mp4", strings.Repeat("Ö", 123)+" (2).mp4")
	slices.Sort(want)
	if got := names(t, moments); !slices.Equal(got, want) {
		t.Errorf("the Moments folder holds\n%q\nwant\n%q", got, want)
	}
}

func TestSaveRemembersWhereTheMomentCameFrom(t *testing.T) {
	home, _ := newHome(t)
	// Keyframes 2 s apart, and B-frames. A release, the one video in its movie
	// folder, which names it, with a title and a comment, and two audio tracks,
	// the second the default; a phone's video, with the phone's creation time
	// and location; a screen recording, with no sound.
	every2s := []string{"-t", "6", "-c:v", "libx264", "-g", "48", "-keyint_min", "48", "-sc_threshold", "0"}
	clip(t, filepath.Join(home, "Downloads/Movies/Clip (2024)/Clip.mkv"), slices.Concat(every2s, []string{"-map", "0:v", "-map", "1:a", "-map", "1:a",
		"-c:a", "aac", "-metadata:s:a:0", "language=eng", "-metadata:s:a:1", "language=spa", "-disposition:a:0", "0", "-disposition:a:1", "default",
		"-metadata", "title=Clip: The Director's Cut", "-metadata", "comment=Ripped from the DVD"})...)
	clip(t, filepath.Join(home, "Videos/Phone.mov"), slices.Concat(every2s, []string{"-c:a", "aac", "-movflags", "use_metadata_tags",
		"-metadata", "creation_time=2020-01-01T00:00:00Z", "-metadata", "com.apple.quicktime.location.ISO6709=+41.3851+002.1734/"})...)
	clip(t, filepath.Join(home, "Videos/Screen.mp4"), slices.Concat(every2s, []string{"-an"})...)
	srv := serve(t, home)
	saves := []struct {
		path  string
		audio any // the audio track chosen, counted from 0, or nil for the default
		title string
		// What the Moment reads back: its Source's name, the audio track it
		// carries, counted from 0, and that track's language, where the Source
		// tags it.
		name, track, language string
	}{
		{"Downloads/Movies/Clip (2024)/Clip.mkv", 0, "English", "Clip (2024)", "0", "eng"},
		{"Downloads/Movies/Clip (2024)/Clip.mkv", nil, "Default", "Clip (2024)", "1", "spa"},
		{"Videos/Phone.mov", nil, "Phone", "Phone", "0", ""},
		{"Videos/Screen.mp4", nil, "Screen", "Screen", "", ""},
	}

	before := time.Now()
	for _, s := range saves {
		postSave(t, srv, map[string]any{"path": s.path, "start": 2.5, "end": 3.5, "audio": s.audio, "title": s.title})
	}
	waitForSaves(t, srv)
	after := time.Now()

	for _, s := range saves {
		src, moment := filepath.Join(home, s.path), filepath.Join(home, "Moments", s.title+".mp4")
		tags := formatTags(t, moment)
		created, err := time.Parse(time.RFC3339, tags["creation_time"])
		if err != nil || created.Before(before.Truncate(time.Second)) || created.After(after) {
			t.Errorf("%s: the Moment's creation_time is %q, want the Save's time, from %v through %v", s.title, tags["creation_time"], before, after)
		}
		// The keyframe at or before the start, and the end of the clean end's
		// frame at or before the end: when the next frame shows.
		frames, end := packetTimes(t, src, "V"), atOrBefore(cleanEnds(t, src), 3.5)
		for key, want := range map[string]float64{"moments.start": atOrBefore(keyframeTimes(t, src), 2.5), "moments.end": frames[slices.Index(frames, end)+1]} {
			if got, err := strconv.ParseFloat(tags[key], 64); err != nil || math.Abs(got-want) > 0.001 {
				t.Errorf("%s: the Moment's %s is %q, want %v", s.title, key, tags[key], want)
			}
		}
		// Besides those, only the muxer's own tags, its brands and FFmpeg's
		// name: no title, and nothing of the Source's.
		for _, key := range []string{"creation_time", "moments.start", "moments.end", "major_brand", "minor_version", "compatible_brands", "encoder"} {
			delete(tags, key)
		}
		want := map[string]string{"moments.source_name": s.name, "moments.source_path": s.path}
		if s.track != "" {
			want["moments.audio_track"] = s.track
		}
		if !maps.Equal(tags, want) {
			t.Errorf("%s: the Moment's other tags are %v, want %v", s.title, tags, want)
		}
		if got := probed(t, moment, "a:0", "stream_tags=language"); s.language != "" && got != s.language {
			t.Errorf("%s: the Moment's audio is in %q, want the Source track's %q", s.title, got, s.language)
		}
	}
}

func TestSaveKeepsTheSourcesRotation(t *testing.T) {
	home, _ := newHome(t)
	// A phone's video, filmed upright: its frames lie on their side, and its
	// display matrix turns them a quarter.
	plain := filepath.Join(t.TempDir(), "plain.mov")
	clip(t, plain, "-t", "4", "-c:v", "libx264", "-g", "48", "-c:a", "aac")
	ffmpeg(t, "-display_rotation", "90", "-i", plain, "-c", "copy", filepath.Join(home, "Videos/Upright.mov"))
	srv := serve(t, home)

	postSave(t, srv, map[string]any{"path": "Videos/Upright.mov", "start": 0, "end": 3, "title": "Upright"})
	waitForSaves(t, srv)

	if got := probed(t, filepath.Join(home, "Moments/Upright.mp4"), "V:0", "stream_side_data=rotation"); got != "90" {
		t.Errorf("the Moment's video turns %q degrees, want the Source's 90", got)
	}
}

func TestSaveGivesHEVCAsHvc1WithItsParameterSets(t *testing.T) {
	home, _ := newHome(t)
	hevc := []string{"-t", "4", "-c:v", "libx265", "-x265-params", "log-level=error:repeat-headers=1", "-tag:v", "hev1", "-c:a", "aac"}
	clip(t, filepath.Join(home, "Videos/hev1.mp4"), hevc...)
	clip(t, filepath.Join(home, "Videos/In-band.mp4"), hevc...)
	bareHvcC(t, filepath.Join(home, "Videos/In-band.mp4"))
	srv := serve(t, home)

	for _, name := range []string{"Videos/hev1.mp4", "Videos/In-band.mp4"} {
		postSave(t, srv, map[string]any{"path": name, "start": 0, "end": 3, "title": filepath.Base(name)})
	}
	waitForSaves(t, srv)

	for _, name := range []string{"Videos/hev1.mp4", "Videos/In-band.mp4"} {
		source, moment := filepath.Join(home, name), filepath.Join(home, "Moments", filepath.Base(name)+".mp4")
		if got := carried(t, moment); got != "hvc1, mp4a mono" {
			t.Errorf("%s: the Moment carries %s, want hvc1, mp4a mono", name, got)
		}
		if got := hvcCUnitTypes(t, moment); !slices.Contains(got, 32) || !slices.Contains(got, 33) || !slices.Contains(got, 34) {
			t.Errorf("%s: the Moment's hvcC holds NAL units of types %v, want a VPS, SPS and PPS: 32, 33 and 34", name, got)
		}
		if !run(packetHashes(t, moment, "V"), packetHashes(t, source, "V")) {
			t.Errorf("%s: the Moment's video packets aren't the Source's own", name)
		}
	}
}

func TestSaveKeepsHDR10sBoxes(t *testing.T) {
	home, _ := newHome(t)
	// A second encode lifts HDR10's metadata from the stream into the container.
	inStream := filepath.Join(t.TempDir(), "in-stream.mkv")
	clip(t, inStream, "-t", "4", "-c:v", "libx265", "-pix_fmt", "yuv420p10le", "-x265-params",
		"log-level=error:hdr10=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:"+
			"master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1):max-cll=1000,400", "-c:a", "aac")
	ffmpeg(t, "-i", inStream, "-c:v", "libx265", "-x265-params", "log-level=error", "-c:a", "copy", filepath.Join(home, "Videos/HDR10.mkv"))
	srv := serve(t, home)

	postSave(t, srv, map[string]any{"path": "Videos/HDR10.mkv", "start": 0, "end": 3, "title": "HDR10"})
	waitForSaves(t, srv)

	moment := readFile(t, filepath.Join(home, "Moments/HDR10.mp4"))
	for _, box := range []string{"colr", "mdcv", "clli"} {
		if !bytes.Contains(moment, []byte(box)) {
			t.Errorf("the Moment has no %s box, want HDR10's colour, mastering display and light level boxes", box)
		}
	}
	if got := probed(t, filepath.Join(home, "Moments/HDR10.mp4"), "V:0", "stream=color_transfer"); !strings.HasPrefix(got, "smpte2084") {
		t.Errorf("the Moment's transfer is %s, want HDR10's smpte2084", got)
	}
}

func TestSaveCopies24BitFLAC(t *testing.T) {
	home, _ := newHome(t)
	clip(t, filepath.Join(home, "Videos/FLAC.mkv"), "-t", "4", "-c:v", "libx264", "-c:a", "flac", "-sample_fmt", "s32")
	// Apple's decoder refuses a frame larger than STREAMINFO's largest, which some releases understate.
	understateLargestFrame(t, filepath.Join(home, "Videos/FLAC.mkv"))
	srv := serve(t, home)

	postSave(t, srv, map[string]any{"path": "Videos/FLAC.mkv", "start": 0, "end": 3, "title": "FLAC"})
	waitForSaves(t, srv)

	source, moment := filepath.Join(home, "Videos/FLAC.mkv"), filepath.Join(home, "Moments/FLAC.mp4")
	if got := carried(t, moment); got != "avc1 8, fLaC mono 24" {
		t.Errorf("the Moment carries %s, want avc1 8, fLaC mono 24", got)
	}
	if !run(packetHashes(t, moment, "a"), packetHashes(t, source, "a")) {
		t.Errorf("the Moment's audio packets aren't the Source's own")
	}
	largest := slices.Max(packetSizes(t, moment, "a"))
	if said := largestFLACFrame(t, moment); said != 0 && said < largest {
		t.Errorf("the Moment's STREAMINFO says its largest frame is %d bytes, want %d or more, or 0 for unknown", said, largest)
	}
}

func understateLargestFrame(t *testing.T, file string) {
	t.Helper()
	contents := readFile(t, file)
	streamInfo := bytes.Index(contents, []byte("fLaC")) + 4 + 4
	copy(contents[streamInfo+7:streamInfo+10], []byte{0, 0, 100})
	if error := os.WriteFile(file, contents, 0o644); error != nil {
		t.Fatal(error)
	}
}

func largestFLACFrame(t *testing.T, file string) int {
	t.Helper()
	contents := readFile(t, file)
	streamInfo := bytes.Index(contents, []byte("dfLa")) + 4 + 4 + 4
	return int(contents[streamInfo+7])<<16 | int(contents[streamInfo+8])<<8 | int(contents[streamInfo+9])
}

func packetSizes(t *testing.T, file, spec string) []int {
	t.Helper()
	var sizes []int
	for _, field := range strings.Fields(probed(t, file, spec, "packet=size")) {
		size, error := strconv.Atoi(field)
		if error != nil {
			t.Fatal(error)
		}
		sizes = append(sizes, size)
	}
	return sizes
}

// The freed bytes become a free box, so no offset moves.
func bareHvcC(t *testing.T, file string) {
	t.Helper()
	contents := readFile(t, file)
	start := bytes.Index(contents, []byte("hvcC")) - 4
	size := int(binary.BigEndian.Uint32(contents[start:]))
	const bareSize = 8 + 23
	binary.BigEndian.PutUint32(contents[start:], bareSize)
	contents[start+bareSize-1] = 0
	binary.BigEndian.PutUint32(contents[start+bareSize:], uint32(size-bareSize))
	copy(contents[start+bareSize+4:], "free")
	if error := os.WriteFile(file, contents, 0o644); error != nil {
		t.Fatal(error)
	}
}

func hvcCUnitTypes(t *testing.T, file string) []int {
	t.Helper()
	contents := readFile(t, file)
	start := bytes.Index(contents, []byte("hvcC")) - 4
	record := contents[start+8 : start+int(binary.BigEndian.Uint32(contents[start:]))]
	var types []int
	offset := 23
	for range int(record[22]) {
		unitType, units := int(record[offset]&0x3f), int(binary.BigEndian.Uint16(record[offset+1:]))
		offset += 3
		for range units {
			types = append(types, unitType)
			offset += 2 + int(binary.BigEndian.Uint16(record[offset:]))
		}
	}
	return types
}

func TestSaveWritesADotfileUntilTheMomentIsWhole(t *testing.T) {
	home, _ := newHome(t)
	// A minute of AC-3, which a Save converts, so that it takes a while.
	short, long := filepath.Join(t.TempDir(), "short.mkv"), filepath.Join(home, "Videos/Long.mkv")
	clip(t, short, "-t", "2", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "ac3")
	ffmpeg(t, "-stream_loop", "29", "-i", short, "-c", "copy", long)
	srv := serve(t, home)
	moments := filepath.Join(home, "Moments")
	before := names(t, moments)

	postSave(t, srv, map[string]any{"path": "Videos/Long.mkv", "start": 0, "end": 59, "title": "Long"})
	// What the Moments folder holds besides what it held, as often as it's read.
	dotfile := false
	for wait := time.Now().Add(time.Minute); ; time.Sleep(time.Millisecond) {
		added := slices.DeleteFunc(names(t, moments), func(name string) bool { return slices.Contains(before, name) })
		if slices.Equal(added, []string{"Long.mp4"}) {
			break
		}
		if len(added) > 1 || len(added) == 1 && !strings.HasPrefix(added[0], ".") {
			t.Fatalf("while the Save runs, the Moments folder holds %q besides what it held, want one dotfile at most", added)
		}
		dotfile = dotfile || len(added) == 1
		if time.Now().After(wait) {
			t.Fatal("the Moment isn't in place after a minute")
		}
	}
	if !dotfile {
		t.Error("the Moments folder held no dotfile while the Save ran")
	}
	waitForSaves(t, srv)
}

func TestASaveWhoseSourceIsGoneFailsAndSaysWhy(t *testing.T) {
	home, _ := newHome(t)
	slowSource(t, home)
	clip(t, filepath.Join(home, "Videos/Gone.mkv"), "-t", "4", "-c:v", "libx264", "-g", "48", "-c:a", "aac")
	srv := serve(t, home)
	moments := filepath.Join(home, "Moments")
	before := names(t, moments)

	postSave(t, srv, map[string]any{"path": "Videos/Slow.mkv", "start": 0, "end": 59, "title": "Slow"})
	postSave(t, srv, map[string]any{"path": "Videos/Gone.mkv", "start": 1, "end": 3, "title": "Gone"})
	if err := os.Remove(filepath.Join(home, "Videos/Gone.mkv")); err != nil {
		t.Fatal(err)
	}
	gone := waitForFailure(t, srv, "Gone")

	if !strings.HasPrefix(gone.Error, "Open failed: ") || !strings.Contains(gone.Error, "no such file") {
		t.Errorf("the Save's error is %q, want the step, Open failed, and the error", gone.Error)
	}
	if got := slices.DeleteFunc(names(t, moments), func(name string) bool { return name == "Slow.mp4" }); !slices.Equal(got, before) {
		t.Errorf("the Moments folder holds %q, want only what it held, %q", got, before)
	}
}

func TestASaveThatFailsItsCheckLeavesNoFile(t *testing.T) {
	home, _ := newHome(t)
	clip(t, filepath.Join(home, "Videos/Clip.mkv"), "-t", "4", "-c:v", "libx264", "-g", "48", "-c:a", "aac")
	failChecks(t).Store(true)
	srv := serve(t, home)
	moments := filepath.Join(home, "Moments")
	before := names(t, moments)

	postSave(t, srv, map[string]any{"path": "Videos/Clip.mkv", "start": 1, "end": 3, "title": "Clip"})
	failed := waitForFailure(t, srv, "Clip")

	if want := "Check failed: ends 1 frame after the mark"; failed.Error != want {
		t.Errorf("the Save's error is %q, want %q", failed.Error, want)
	}
	if got := names(t, moments); !slices.Equal(got, before) {
		t.Errorf("the Moments folder holds %q, want only what it held, %q", got, before)
	}
	if code := askSave(t, srv, http.MethodDelete, failed.ID, ""); code != http.StatusNoContent {
		t.Errorf("DELETE the failed Save: %d, want %d", code, http.StatusNoContent)
	}
	if got := listSaves(t, srv); len(got) != 0 {
		t.Errorf("after Dismiss, the server lists %+v, want no Saves", got)
	}
	if code := askSave(t, srv, http.MethodDelete, failed.ID, ""); code != http.StatusNotFound {
		t.Errorf("DELETE a dismissed Save: %d, want %d", code, http.StatusNotFound)
	}
}

func TestAVP9SaveWithoutAGPUFailsWithTheEncodersError(t *testing.T) {
	home, _ := newHome(t)
	clip(t, filepath.Join(home, "Downloads/metube/VP9 [aqz-KE-bpKQ].webm"), "-t", "4", "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-c:a", "libopus")
	server := serve(t, home)
	moments := filepath.Join(home, "Moments")
	before := names(t, moments)

	postSave(t, server, map[string]any{"path": "Downloads/metube/VP9 [aqz-KE-bpKQ].webm", "start": 1, "end": 3, "title": "VP9"})
	failed := waitForFailure(t, server, "VP9")

	if want := "Write failed: Error parsing global options: Invalid argument"; failed.Error != want {
		t.Errorf("the Save's error is %q, want FFmpeg's on finding no GPU, %q", failed.Error, want)
	}
	if got := names(t, moments); !slices.Equal(got, before) {
		t.Errorf("the Moments folder holds %q, want only what it held, %q", got, before)
	}
}

func TestRetryRunsTheSameSaveAgainAtTheBackOfTheLine(t *testing.T) {
	home, _ := newHome(t)
	slowSource(t, home)
	clip(t, filepath.Join(home, "Videos/Tracks.mkv"), "-t", "4", "-c:v", "libx264", "-g", "48", "-map", "0:v", "-map", "1:a", "-map", "1:a", "-c:a", "aac")
	fail := failChecks(t)
	fail.Store(true)
	srv := serve(t, home)
	same := map[string]any{"path": "Videos/Tracks.mkv", "start": 2.5, "end": 3.5, "audio": 1}

	first := map[string]any{"title": "First"}
	maps.Copy(first, same)
	postSave(t, srv, first)
	failed := waitForFailure(t, srv, "First")
	fail.Store(false)
	postSave(t, srv, map[string]any{"path": "Videos/Slow.mkv", "start": 0, "end": 59, "title": "Slow"})
	second := map[string]any{"title": "Second"}
	maps.Copy(second, same)
	postSave(t, srv, second)
	waiting := listSaves(t, srv)[1]

	if code := askSave(t, srv, http.MethodPost, failed.ID, "/retry"); code != http.StatusOK {
		t.Fatalf("POST retry of the failed Save: %d, want %d", code, http.StatusOK)
	}
	var line []string
	for _, s := range listSaves(t, srv) {
		line = append(line, s.Title+" "+s.State)
	}
	if want := []string{"Slow saving", "Second waiting", "First waiting"}; !slices.Equal(line, want) {
		t.Errorf("after Retry, the server lists %q, want %q", line, want)
	}
	if code := askSave(t, srv, http.MethodPost, waiting.ID, "/retry"); code != http.StatusConflict {
		t.Errorf("POST retry of a waiting Save: %d, want %d", code, http.StatusConflict)
	}
	if code := askSave(t, srv, http.MethodDelete, waiting.ID, ""); code != http.StatusConflict {
		t.Errorf("DELETE a waiting Save: %d, want %d", code, http.StatusConflict)
	}
	waitForSaves(t, srv)

	again, other := formatTags(t, filepath.Join(home, "Moments/First.mp4")), formatTags(t, filepath.Join(home, "Moments/Second.mp4"))
	for _, key := range []string{"moments.source_path", "moments.start", "moments.end", "moments.audio_track"} {
		if again[key] != other[key] {
			t.Errorf("the retried Moment's %s is %q, want the same Save's %q", key, again[key], other[key])
		}
	}
}

func TestTheServerSaysHowEachSaveIsGoing(t *testing.T) {
	home, _ := newHome(t)
	slowSource(t, home)
	clip(t, filepath.Join(home, "Videos/Gone.mkv"), "-t", "4", "-c:v", "libx264", "-g", "48", "-c:a", "aac")
	srv := serve(t, home)

	postSave(t, srv, map[string]any{"path": "Videos/Slow.mkv", "start": 0, "end": 59, "title": "Slow"})
	postSave(t, srv, map[string]any{"path": "Videos/Gone.mkv", "start": 1, "end": 3, "title": "Gone"})
	if err := os.Remove(filepath.Join(home, "Videos/Gone.mkv")); err != nil {
		t.Fatal(err)
	}
	said := map[string][]string{}
	for wait := time.Now().Add(time.Minute); !slices.Contains(said["Gone"], "failed"); time.Sleep(20 * time.Millisecond) {
		if time.Now().After(wait) {
			t.Fatalf("after a minute, the list has said %q", said)
		}
		for _, listed := range listSaves(t, srv) {
			state := listed.State
			if state == "saving" {
				state += fmt.Sprintf(" %d%%", listed.Percent)
			}
			if history := said[listed.Title]; len(history) == 0 || history[len(history)-1] != state {
				said[listed.Title] = append(history, state)
			}
		}
	}

	if gone := said["Gone"]; gone[0] != "waiting" {
		t.Errorf("the list said of the Save behind the slow one %q, want waiting first", gone)
	}
	var percents []int
	for _, state := range said["Slow"] {
		var percent int
		if _, err := fmt.Sscanf(state, "saving %d%%", &percent); err == nil {
			percents = append(percents, percent)
		}
	}
	if len(percents) < 3 || !slices.IsSorted(percents) || percents[len(percents)-1] > 100 {
		t.Errorf("the list said of the slow Save %q, want a percentage rising three times or more, to 100 at most", said["Slow"])
	}
}

func TestCheckFindsAMomentThatIsntAsPlanned(t *testing.T) {
	dir := t.TempDir()
	moment, cut := filepath.Join(dir, "moment.mp4"), filepath.Join(dir, "cut.mp4")
	clip(t, moment, "-t", "4", "-c:v", "libx264", "-g", "48", "-an")
	ffmpeg(t, "-i", moment, "-ss", "0.5", "-c", "copy", "-copyinkf", cut)
	frameLength := 1.0 / 24

	for _, check := range []struct {
		file      string
		lastFrame float64
		want      string
	}{
		{moment, 95 * frameLength, ""},
		{moment, 94 * frameLength, "ends 1 frame after the mark"},
		{moment, 98 * frameLength, "ends 3 frames before the mark"},
		{cut, 83 * frameLength, "starts on a frame that isn't a keyframe"},
	} {
		err := checkMoment(t.Context(), check.file, check.lastFrame, frameLength)
		if got := fmt.Sprint(err); check.want == "" && err != nil || check.want != "" && got != check.want {
			t.Errorf("checkMoment(%s, last frame at %v s) is %v, want %q", filepath.Base(check.file), check.lastFrame, err, check.want)
		}
	}
}

func slowSource(t *testing.T, home string) {
	t.Helper()
	short := filepath.Join(t.TempDir(), "short.mkv")
	clip(t, short, "-t", "2", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "ac3")
	ffmpeg(t, "-stream_loop", "29", "-i", short, "-c", "copy", filepath.Join(home, "Videos/Slow.mkv"))
}

func failChecks(t *testing.T) *atomic.Bool {
	t.Helper()
	var fail atomic.Bool
	t.Cleanup(func() { checkSave = checkMoment })
	checkSave = func(ctx context.Context, file string, lastFrame, frameLength float64) error {
		if fail.Load() {
			return errors.New("ends 1 frame after the mark")
		}
		return checkMoment(ctx, file, lastFrame, frameLength)
	}
	return &fail
}

type listedSave struct {
	ID                  int
	Title, State, Error string
	Percent             int
}

func listSaves(t *testing.T, srv *httptest.Server) []listedSave {
	t.Helper()
	var saves []listedSave
	if err := json.Unmarshal([]byte(get(t, srv.URL+"/api/saves", "application/json")), &saves); err != nil {
		t.Fatal(err)
	}
	return saves
}

func waitForFailure(t *testing.T, srv *httptest.Server, title string) listedSave {
	t.Helper()
	for wait := time.Now().Add(time.Minute); time.Now().Before(wait); time.Sleep(20 * time.Millisecond) {
		for _, listed := range listSaves(t, srv) {
			if listed.Title == title && listed.State == "failed" {
				return listed
			}
		}
	}
	t.Fatalf("the Save %q hasn't failed after a minute: %+v", title, listSaves(t, srv))
	return listedSave{}
}

func askSave(t *testing.T, srv *httptest.Server, method string, id int, path string) int {
	t.Helper()
	request, err := http.NewRequest(method, fmt.Sprintf("%s/api/saves/%d%s", srv.URL, id, path), nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	return response.StatusCode
}

// postSave asks the server for the Save s, as the Trimmer's Save does.
func postSave(t *testing.T, srv *httptest.Server, s map[string]any) {
	t.Helper()
	body, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	res, err := http.Post(srv.URL+"/api/saves", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusAccepted {
		why, _ := io.ReadAll(res.Body)
		t.Fatalf("POST /api/saves %s: %s: %s", body, res.Status, why)
	}
}

// waitForSaves waits until the server has no Save on its way, as the page
// polls for them, and fails on one that failed.
func waitForSaves(t *testing.T, srv *httptest.Server) {
	t.Helper()
	for wait := time.Now().Add(time.Minute); ; time.Sleep(20 * time.Millisecond) {
		var saves []struct{ Title, State, Error string }
		if err := json.Unmarshal([]byte(get(t, srv.URL+"/api/saves", "application/json")), &saves); err != nil {
			t.Fatal(err)
		}
		if len(saves) == 0 {
			return
		}
		for _, s := range saves {
			if s.State == "failed" {
				t.Fatalf("the Save %q failed: %s", s.Title, s.Error)
			}
		}
		if time.Now().After(wait) {
			t.Fatalf("Saves still on their way after a minute: %+v", saves)
		}
	}
}

// atOrBefore finds the latest of times at or before time, or else the first.
func atOrBefore(times []float64, time float64) float64 {
	latest := times[0]
	for _, t := range times {
		if t <= time {
			latest = t
		}
	}
	return latest
}

// chosen is the audio track chosen, or 0, the default in these Sources.
func chosen(audio any) any {
	if audio == nil {
		return 0
	}
	return audio
}

// firstPacket reads the presentation time and flags of the first packet in
// file's first video, as ffprobe writes them: "0.000000,K__".
func firstPacket(t *testing.T, file string) string {
	t.Helper()
	out, err := exec.Command("ffprobe", "-v", "error", "-select_streams", "V:0", "-read_intervals", "%+#1",
		"-show_entries", "packet=pts_time,flags", "-of", "csv=p=0", file).Output()
	if err != nil {
		t.Fatalf("ffprobe %s: %v", file, err)
	}
	return strings.TrimSpace(string(out))
}

// shownTimes reads the presentation times of the frames of file's first video
// that show, in order: all but those an edit list keeps from showing, which
// ffprobe flags D.
func shownTimes(t *testing.T, file string) []float64 {
	t.Helper()
	out, err := exec.Command("ffprobe", "-v", "error", "-select_streams", "V:0",
		"-show_entries", "packet=pts_time,flags", "-of", "csv=p=0", file).Output()
	if err != nil {
		t.Fatalf("ffprobe %s: %v", file, err)
	}
	var times []float64
	for line := range strings.FieldsSeq(string(out)) {
		pts, flags, _ := strings.Cut(line, ",")
		if strings.Contains(flags, "D") {
			continue
		}
		time, err := strconv.ParseFloat(pts, 64)
		if err != nil {
			t.Fatalf("ffprobe %s: %v", file, err)
		}
		times = append(times, time)
	}
	slices.Sort(times)
	return times
}

// streamEnd reads when file's first stream of the type ffprobe's spec selects
// ends: the end of its last packet that shows.
func streamEnd(t *testing.T, file, spec string) float64 {
	t.Helper()
	out, err := exec.Command("ffprobe", "-v", "error", "-select_streams", spec+":0",
		"-show_entries", "packet=pts_time,duration_time,flags", "-of", "csv=p=0", file).Output()
	if err != nil {
		t.Fatalf("ffprobe %s: %v", file, err)
	}
	end := math.Inf(-1)
	for line := range strings.FieldsSeq(string(out)) {
		fields := strings.Split(line, ",")
		pts, err1 := strconv.ParseFloat(fields[0], 64)
		duration, err2 := strconv.ParseFloat(fields[1], 64)
		if err1 != nil || err2 != nil || strings.Contains(fields[2], "D") {
			continue
		}
		end = max(end, pts+duration)
	}
	return end
}

// packetHashes hashes each packet of file's first stream of the type
// ffprobe's spec selects ("V", "a", "a:1"), in decode order, as it is.
func packetHashes(t *testing.T, file, spec string) []string {
	t.Helper()
	if !strings.Contains(spec, ":") {
		spec += ":0"
	}
	out, err := exec.Command("ffmpeg", "-v", "error", "-i", file, "-map", "0:"+spec, "-c", "copy", "-f", "framemd5", "-").Output()
	if err != nil {
		t.Fatalf("ffmpeg %s: %v", file, err)
	}
	// Each line has the stream, decode and presentation times, duration, size
	// and hash, then any side data's.
	var hashes []string
	for line := range strings.Lines(string(out)) {
		if !strings.HasPrefix(line, "#") {
			hashes = append(hashes, strings.TrimSpace(strings.Split(line, ",")[5]))
		}
	}
	return hashes
}

// formatTags reads the tags of file's container with ffprobe.
func formatTags(t *testing.T, file string) map[string]string {
	t.Helper()
	out, err := exec.Command("ffprobe", "-v", "error", "-show_entries", "format_tags", "-of", "json", file).Output()
	if err != nil {
		t.Fatalf("ffprobe %s: %v", file, err)
	}
	var probe struct {
		Format struct{ Tags map[string]string }
	}
	if err := json.Unmarshal(out, &probe); err != nil {
		t.Fatalf("ffprobe %s: %v", file, err)
	}
	return probe.Format.Tags
}

// probed reads entries of file's stream that ffprobe's spec selects, as
// ffprobe writes them: "90" for a quarter turn's stream_side_data=rotation.
func probed(t *testing.T, file, spec, entries string) string {
	t.Helper()
	out, err := exec.Command("ffprobe", "-v", "error", "-select_streams", spec, "-show_entries", entries, "-of", "csv=p=0", file).Output()
	if err != nil {
		t.Fatalf("ffprobe %s: %v", file, err)
	}
	return strings.TrimSpace(string(out))
}

// readFile reads file whole.
func readFile(t *testing.T, file string) []byte {
	t.Helper()
	b, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// names lists the names in dir, in order.
func names(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}

// run reports whether part is a run of whole, in order and unbroken.
func run(part, whole []string) bool {
	return len(part) > 0 && strings.Contains(" "+strings.Join(whole, " ")+" ", " "+strings.Join(part, " ")+" ")
}

func TestStartingRemovesHalfWrittenMomentsOnly(t *testing.T) {
	home, _ := newHome(t)
	moments := filepath.Join(home, "Moments")
	for _, name := range []string{".saving-1.mp4", ".DS_Store"} {
		if err := os.WriteFile(filepath.Join(moments, name), nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	serve(t, home)

	if got, want := names(t, moments), []string{".DS_Store", "Tears of Steel (2012).mp4"}; !slices.Equal(got, want) {
		t.Errorf("once started, the Moments folder holds %q, want %q", got, want)
	}
}

func TestSavesSurviveARestart(t *testing.T) {
	for _, stop := range []syscall.Signal{syscall.SIGTERM, syscall.SIGKILL} {
		t.Run(stop.String(), func(t *testing.T) {
			home, _ := newHome(t)
			slowSource(t, home)
			clip(t, filepath.Join(home, "Videos/Clip.mkv"), "-t", "4", "-c:v", "libx264", "-g", "48", "-c:a", "aac")
			// Its index is whole and half its media gone, so its Save fails.
			truncated := filepath.Join(home, "Videos/Truncated.mp4")
			clip(t, truncated, "-t", "4", "-c:v", "libx264", "-g", "48", "-c:a", "aac", "-movflags", "+faststart")
			if err := os.Truncate(truncated, int64(len(readFile(t, truncated))/2)); err != nil {
				t.Fatal(err)
			}
			moments := filepath.Join(home, "Moments")
			before := names(t, moments)
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			address := listener.Addr().String()
			listener.Close()
			srv := &httptest.Server{URL: "http://" + address}
			server := startServer(t, home, address)

			postSave(t, srv, map[string]any{"path": "Videos/Truncated.mp4", "start": 1, "end": 3, "title": "Failed"})
			postSave(t, srv, map[string]any{"path": "Videos/Slow.mkv", "start": 0, "end": 59, "title": "Slow"})
			postSave(t, srv, map[string]any{"path": "Videos/Clip.mkv", "start": 1, "end": 3, "title": "Third"})
			postSave(t, srv, map[string]any{"path": "Videos/Clip.mkv", "start": 2, "end": 3, "title": "Fourth"})
			var made []listedSave
			for wait := time.Now().Add(time.Minute); ; time.Sleep(time.Millisecond) {
				made = listSaves(t, srv)
				if len(made) == 4 && made[0].State == "failed" && made[1].State == "saving" && made[1].Percent > 0 {
					break
				}
				if time.Now().After(wait) {
					t.Fatalf("after a minute, the server lists %+v, want the first failed and the second saving", made)
				}
			}
			stopServer(t, server, stop)
			if added := slices.DeleteFunc(names(t, moments), func(name string) bool { return slices.Contains(before, name) }); len(added) != 1 || !strings.HasPrefix(added[0], ".") {
				t.Fatalf("stopped during the second Save, the Moments folder holds %q besides what it held, want its dotfile", added)
			}
			startServer(t, home, address)

			restarted := listSaves(t, srv)
			if len(restarted) != 4 {
				t.Fatalf("after the restart, the server lists %+v, want the four Saves", restarted)
			}
			for i, want := range []string{"failed", "saving", "waiting", "waiting"} {
				// The second can still be waiting for the worker.
				if got := restarted[i]; got.ID != made[i].ID || got.Title != made[i].Title || got.State != want && !(i == 1 && got.State == "waiting") {
					t.Errorf("after the restart, Save %d is %+v, want %+v %s", i+1, got, made[i], want)
				}
			}
			for wait := time.Now().Add(time.Minute); len(restarted) > 1; time.Sleep(20 * time.Millisecond) {
				if restarted = listSaves(t, srv); time.Now().After(wait) {
					t.Fatalf("after a minute, the server lists %+v, want the failed Save alone", restarted)
				}
			}
			if restarted[0].ID != made[0].ID || restarted[0].State != "failed" {
				t.Errorf("once the rest are done, the server lists %+v, want the failed one, %+v", restarted, made[0])
			}
			if got, want := slices.DeleteFunc(names(t, moments), func(name string) bool { return slices.Contains(before, name) }), []string{"Fourth.mp4", "Slow.mp4", "Third.mp4"}; !slices.Equal(got, want) {
				t.Errorf("the Moments folder holds %q besides what it held, want %q", got, want)
			}
		})
	}
}

// startServer runs the server as its own process on home, with its app data
// next to it as serve has it, at address, until it's stopped or the test ends.
// It's in a process group of its own, as a container holds it.
func startServer(t *testing.T, home, address string) *exec.Cmd {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	data := filepath.Join(home, "../data")
	if err := os.MkdirAll(data, 0o755); err != nil {
		t.Fatal(err)
	}
	server := exec.Command(executable, "-test.run=^$")
	server.Env = append(os.Environ(), "MOMENTS_TEST_SERVER=1", "MOMENTS_HOME="+home, "MOMENTS_DATA="+data, "MOMENTS_ADDR="+address)
	server.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	output := &bytes.Buffer{}
	server.Stdout, server.Stderr = output, output
	if err := server.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		stopServer(t, server, syscall.SIGKILL)
		if t.Failed() {
			t.Logf("the server's log:\n%s", output)
		}
	})
	for wait := time.Now().Add(10 * time.Second); ; time.Sleep(10 * time.Millisecond) {
		if response, err := http.Get("http://" + address + "/api/mounts"); err == nil {
			response.Body.Close()
			return server
		}
		if time.Now().After(wait) {
			t.Fatalf("the server doesn't answer after 10 s:\n%s", output)
		}
	}
}

// stopServer sends the server signal, then, once it has ended, kills what it
// started, as a container's end does.
func stopServer(t *testing.T, server *exec.Cmd, signal syscall.Signal) {
	t.Helper()
	if server.ProcessState != nil {
		return
	}
	if err := server.Process.Signal(signal); err != nil {
		t.Fatal(err)
	}
	server.Wait()
	syscall.Kill(-server.Process.Pid, syscall.SIGKILL)
}

func TestUnreadableSavesAreSetAside(t *testing.T) {
	home, _ := newHome(t)
	data := filepath.Join(home, "../data")
	if err := os.MkdirAll(data, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(data, "saves.json"), []byte(`[{"id":1,"pa`), 0o644); err != nil {
		t.Fatal(err)
	}
	srv := serve(t, home)

	if got := listSaves(t, srv); len(got) != 0 {
		t.Errorf("with saves.json cut short, the server lists %+v, want no Saves", got)
	}
	if got := string(readFile(t, filepath.Join(data, "saves.json.unreadable"))); got != `[{"id":1,"pa` {
		t.Errorf("saves.json.unreadable holds %q, want what saves.json held", got)
	}
}
