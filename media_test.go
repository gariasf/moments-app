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
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestProbeTellsHowTheTrimmerOpensASource(t *testing.T) {
	home, _ := newHome(t)
	h264, aac := []string{"-t", "4", "-c:v", "libx264", "-level", "3.0"}, []string{"-c:a", "aac"}
	hevc, opus := []string{"-t", "4", "-c:v", "libx265", "-x265-params", "log-level=error"}, []string{"-c:a", "libopus"}
	// Codec strings as RFC 6381 writes them, from what ffprobe reads of each
	// clip: HEVC's profile and its compatibility flags, tier and level, then
	// the constraint flags x265 sets (progressive, frames only); AV1's
	// profile, level, tier and bit depth; VP9's profile, the level FFmpeg
	// gives 320x240 at 24 fps, and its bit depth.
	sources := map[string]struct {
		args      []string
		end       float64 // where the Source ends, in its own time
		codecs    string
		frameRate float64 // when the Trimmer plays it
		cantPlay  string
	}{
		"Downloads/Movies/Clip (2024)/Clip.mp4":   {slices.Concat(h264, aac), 4, "avc1.64001e, mp4a.40.2", 24, ""},
		"Downloads/Movies/Late (2024)/Late.mkv":   {slices.Concat(h264, aac, []string{"-output_ts_offset", "10"}), 14, "avc1.64001e, mp4a.40.2", 24, ""},
		"Downloads/Movies/Late (2024)/Late.mp4":   {slices.Concat(h264, aac, []string{"-output_ts_offset", "10"}), 14, "avc1.64001e, mp4a.40.2", 24, ""},
		"Videos/High 10.mkv":                      {slices.Concat(h264, []string{"-profile:v", "high10", "-pix_fmt", "yuv420p10le"}, aac), 4, "avc1.6e001e, mp4a.40.2", 24, ""},
		"Videos/Silent.mp4":                       {slices.Concat(h264, []string{"-an", "-r", "30000/1001"}), 4, "avc1.64001e", 30000.0 / 1001, ""},
		"Videos/HEVC.mkv":                         {slices.Concat(hevc, aac), 4, "hvc1.1.6.L60.90, mp4a.40.2", 24, ""},
		"Videos/hev1.mp4":                         {slices.Concat(hevc, []string{"-profile:v", "main10", "-pix_fmt", "yuv420p10le", "-tag:v", "hev1"}, aac), 4, "hev1.2.4.L60.90, mp4a.40.2", 24, ""},
		"Downloads/metube/AV1 [aqz-KE-bpKQ].webm": {slices.Concat([]string{"-t", "4", "-c:v", "libsvtav1", "-preset", "12"}, opus), 4, "av01.0.00M.08, Opus", 24, ""},
		"Downloads/metube/VP9 [aqz-KE-bpKQ].webm": {slices.Concat([]string{"-t", "4", "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8"}, opus), 4, "vp09.00.20.08, Opus", 24, ""},
		"Videos/FLAC.mkv":                         {slices.Concat(h264, []string{"-c:a", "flac", "-sample_fmt", "s32"}), 4, "avc1.64001e, fLaC", 24, ""},
		"Videos/AC-3.mkv":                         {slices.Concat(h264, []string{"-c:a", "ac3"}), 4, "avc1.64001e, mp4a.40.2", 24, ""},
		"Videos/AAC Main.mp4":                     {slices.Concat(h264, aac, []string{"-profile:a", "aac_main"}), 4, "avc1.64001e, mp4a.40.2", 24, ""},
		"Videos/4-2-2.mkv":                        {slices.Concat(h264, []string{"-profile:v", "high422", "-pix_fmt", "yuv422p"}, aac), 4, "", 0, "its video is H.264 High 4:2:2"},
		"Videos/MPEG-2.mkv":                       {slices.Concat([]string{"-t", "4", "-c:v", "mpeg2video"}, aac), 4, "", 0, "its video is MPEG-2 video"},
		"Videos/Song.mp4":                         {slices.Concat([]string{"-t", "4", "-vn"}, aac), 4, "", 0, "it has no video"},
	}
	for name, s := range sources {
		clip(t, filepath.Join(home, name), s.args...)
	}
	srv := serve(t, home)

	for name, want := range sources {
		got := probeOf(t, srv, name)
		end, _ := got["duration"].(float64)
		codecs, _ := got["codecs"].(string)
		frameRate, _ := got["frameRate"].(float64)
		cantPlay, _ := got["cantPlay"].(string)
		if math.Abs(end-want.end) > 0.1 || codecs != want.codecs || math.Abs(frameRate-want.frameRate) > 1e-9 || cantPlay != want.cantPlay {
			t.Errorf("%s: probed as %v, want it to end at %v s with codecs %q at %v frames a second, or can't play as %q", name, got, want.end, want.codecs, want.frameRate, want.cantPlay)
		}
	}
}

func TestProbeOfALongSourceAnswersAtOnce(t *testing.T) {
	home, _ := newHome(t)
	// 10 minutes of AC-3, which FFmpeg takes about half a minute to convert
	// whole: the probe reads only the start of its stream.
	short, long := filepath.Join(t.TempDir(), "short.mkv"), filepath.Join(home, "Videos/Long.mkv")
	clip(t, short, "-t", "2", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "ac3", "-b:a", "96k", "-ch_layout", "5.1(side)")
	ffmpeg(t, "-stream_loop", "299", "-i", short, "-c", "copy", long)
	srv := serve(t, home)

	start := time.Now()
	probeOf(t, srv, "Videos/Long.mkv")
	if took := time.Since(start); took > 5*time.Second {
		t.Errorf("the probe took %v, want 5 s at most", took.Round(time.Millisecond))
	}
}

func TestProbeFollowsASourceReplacedInPlace(t *testing.T) {
	home, _ := newHome(t)
	path := filepath.Join(home, "Downloads/metube/Clip.mkv")
	clip(t, path, "-t", "2", "-c:v", "libx264", "-level", "3.0", "-c:a", "aac")
	srv := serve(t, home)
	if got := probeOf(t, srv, "Downloads/metube/Clip.mkv")["codecs"]; got != "avc1.64001e, mp4a.40.2" {
		t.Fatalf("probed the codecs %v, want avc1.64001e, mp4a.40.2", got)
	}

	// Downloaded again, with AC-3 to convert rather than AAC to copy.
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	clip(t, path, "-t", "2", "-c:v", "libx264", "-level", "3.0", "-c:a", "ac3", "-ch_layout", "5.1(side)")
	probeOf(t, srv, "Downloads/metube/Clip.mkv")
	file, _ := streamOf(t, srv, "Downloads/metube/Clip.mkv", 0)
	if got := carried(t, file); got != "avc1 8, mp4a 5.1" {
		t.Errorf("the stream carries %s once the Source was replaced, want avc1 8, mp4a 5.1", got)
	}
}

func TestStreamIsFragmentedMP4InTheSourcesOwnTime(t *testing.T) {
	home, _ := newHome(t)
	// B-frames start the video's decode times before its first frame's time,
	// and the Matroska Source starts 10 s in, as some remuxes do.
	sources := map[string][]string{
		"Downloads/Movies/Late (2024)/Late.mkv": {"-output_ts_offset", "10"},
		"Downloads/Movies/Clip (2024)/Clip.mp4": nil,
		"Videos/Silent.mp4":                     {"-an"},
	}
	for name, args := range sources {
		clip(t, filepath.Join(home, name), slices.Concat([]string{"-t", "6", "-c:v", "libx264", "-bf", "2", "-g", "48", "-c:a", "aac"}, args)...)
	}
	srv := serve(t, home)

	for name := range sources {
		file, body := streamOf(t, srv, name, 0)
		// The header, then fragments of a second at most, 6 or more for 6 s,
		// and once the stream ends, an index of them.
		if got := strings.Join(boxTypes(body), " "); !regexp.MustCompile(`^ftyp moov( moof mdat){6,}( mfra)?$`).MatchString(got) {
			t.Errorf("%s: the stream's boxes are %s, want ftyp, moov, then a moof and an mdat per second", name, got)
		}
		src := filepath.Join(home, name)
		if got, want := packetTimes(t, file, "v"), packetTimes(t, src, "V"); !slices.Equal(got, want) {
			t.Errorf("%s: the stream's video is at %s, want %s", name, brief(got), brief(want))
		}
		// Matroska keeps times in milliseconds, and the stream's audio in samples.
		withinMs := func(a, b float64) bool { return math.Abs(a-b) <= 0.001 }
		if got, want := packetTimes(t, file, "a"), packetTimes(t, src, "a"); !slices.EqualFunc(got, want, withinMs) {
			t.Errorf("%s: the stream's audio is at %s, want %s", name, brief(got), brief(want))
		}
	}
}

func TestStreamCarriesWhatAMomentWill(t *testing.T) {
	home, _ := newHome(t)
	h264, hevc := []string{"-t", "2", "-c:v", "libx264"}, []string{"-t", "2", "-c:v", "libx265", "-x265-params", "log-level=error"}
	sources := map[string]struct {
		args    []string
		carries string // the stream's streams, as carried describes them
		copies  bool   // the Source's own audio packets
	}{
		"Videos/HEVC.mkv":        {slices.Concat(hevc, []string{"-c:a", "aac"}), "hvc1, mp4a mono", true},
		"Videos/hev1.mp4":        {slices.Concat(hevc, []string{"-profile:v", "main10", "-pix_fmt", "yuv420p10le", "-tag:v", "hev1", "-c:a", "aac"}), "hev1, mp4a mono", true},
		"Videos/AC-3.mkv":        {slices.Concat(h264, []string{"-c:a", "ac3", "-ch_layout", "5.1(side)"}), "avc1 8, mp4a 5.1", false},
		"Videos/E-AC-3.mkv":      {slices.Concat(h264, []string{"-c:a", "eac3", "-ch_layout", "5.1(side)"}), "avc1 8, mp4a 5.1", false},
		"Videos/DTS.mkv":         {slices.Concat(h264, []string{"-c:a", "dca", "-strict", "-2", "-ch_layout", "5.1(side)"}), "avc1 8, mp4a 5.1", false},
		"Videos/TrueHD.mkv":      {slices.Concat(h264, []string{"-c:a", "truehd", "-strict", "-2", "-ch_layout", "5.1(side)"}), "avc1 8, mp4a 5.1", false},
		"Videos/PCM.mkv":         {slices.Concat(h264, []string{"-c:a", "pcm_s16le", "-ch_layout", "7.1"}), "avc1 8, mp4a 7.1", false},
		"Videos/PCM 6.1.mkv":     {slices.Concat(h264, []string{"-c:a", "pcm_s24le", "-ch_layout", "6.1"}), "avc1 8, mp4a 7.1", false},
		"Videos/PCM stereo.mkv":  {slices.Concat(h264, []string{"-c:a", "pcm_s24le", "-ch_layout", "stereo"}), "avc1 8, mp4a stereo", false},
		"Videos/FLAC 24-bit.mkv": {slices.Concat(h264, []string{"-c:a", "flac", "-sample_fmt", "s32"}), "avc1 8, fLaC mono 16", false},
		"Videos/FLAC.mkv":        {slices.Concat(h264, []string{"-c:a", "flac"}), "avc1 8, fLaC mono 16", true},
		"Videos/Opus.mkv":        {slices.Concat(h264, []string{"-c:a", "libopus"}), "avc1 8, Opus mono", true},
		"Videos/Silent.mkv":      {slices.Concat(h264, []string{"-an"}), "avc1 8", false},
		// The default audio track is the second, in 5.1.
		"Videos/Tracks.mkv": {slices.Concat(h264, []string{"-map", "0:v", "-map", "1:a", "-map", "1:a", "-c:a:0", "aac", "-c:a:1", "ac3",
			"-ch_layout:a:1", "5.1(side)", "-disposition:a:0", "0", "-disposition:a:1", "default"}), "avc1 8, mp4a 5.1", false},
	}
	for name, s := range sources {
		clip(t, filepath.Join(home, name), s.args...)
	}
	srv := serve(t, home)

	for name, want := range sources {
		file, _ := streamOf(t, srv, name, 0)
		if got := carried(t, file); got != want.carries {
			t.Errorf("%s: the stream carries %s, want %s", name, got, want.carries)
		}
		if want.copies {
			if got, want := audioHash(t, file, 0), audioHash(t, filepath.Join(home, name), 0); got != want {
				t.Errorf("%s: the stream's audio packets hash to %s, want the Source's own: %s", name, got, want)
			}
		}
	}
}

func TestStreamCarriesTheAudioTrackChosen(t *testing.T) {
	home, _ := newHome(t)
	// Three tracks, the second the default: AAC, which copies, AC-3 5.1, which
	// converts, and Opus, which copies.
	clip(t, filepath.Join(home, "Videos/Tracks.mkv"), "-t", "2", "-c:v", "libx264", "-level", "3.0",
		"-map", "0:v", "-map", "1:a", "-map", "1:a", "-map", "1:a",
		"-c:a:0", "aac", "-metadata:s:a:0", "language=eng", "-disposition:a:0", "0",
		"-c:a:1", "ac3", "-ch_layout:a:1", "5.1(side)", "-metadata:s:a:1", "language=spa", "-disposition:a:1", "default",
		"-c:a:2", "libopus", "-metadata:s:a:2", "language=jpn", "-disposition:a:2", "0")
	srv := serve(t, home)

	// The tracks to choose from, in order, and the one the Trimmer starts on.
	want := `[{"channels":1,"codec":"AAC","language":"eng"},{"channels":6,"codec":"AC-3","default":true,"language":"spa"},{"channels":1,"codec":"Opus","language":"jpn"}]`
	if got, _ := json.Marshal(probeOf(t, srv, "Videos/Tracks.mkv")["audioTracks"]); string(got) != want {
		t.Errorf("the probe lists the audio tracks as %s, want %s", got, want)
	}

	// Each track's stream carries that track, copied or converted as a Moment
	// would, and its type gives the codecs MediaSource needs for it, which can
	// differ from the probe's.
	for n, want := range []struct {
		carries string // as carried describes it
		copies  bool   // the Source's own audio packets
		codecs  string
	}{
		{"avc1 8, mp4a mono", true, "avc1.64001e, mp4a.40.2"},
		{"avc1 8, mp4a 5.1", false, "avc1.64001e, mp4a.40.2"},
		{"avc1 8, Opus mono", true, "avc1.64001e, Opus"},
	} {
		stream := get(t, srv.URL+"/api/source/stream?"+url.Values{"path": {"Videos/Tracks.mkv"}, "audio": {fmt.Sprint(n)}}.Encode(), `video/mp4; codecs="`+want.codecs+`"`)
		file := filepath.Join(t.TempDir(), "stream.mp4")
		if err := os.WriteFile(file, []byte(stream), 0o644); err != nil {
			t.Fatal(err)
		}
		if got := carried(t, file); got != want.carries {
			t.Errorf("track %d: the stream carries %s, want %s", n, got, want.carries)
		}
		if want.copies {
			if got, want := audioHash(t, file, 0), audioHash(t, filepath.Join(home, "Videos/Tracks.mkv"), n); got != want {
				t.Errorf("track %d: the stream's audio packets hash to %s, want the track's own: %s", n, got, want)
			}
		}
	}
}

func TestStreamCarriesTheVideoNotItsCoverArt(t *testing.T) {
	home, _ := newHome(t)
	tmp := t.TempDir()
	art, plain, tagged := filepath.Join(tmp, "art.png"), filepath.Join(tmp, "plain.mp4"), filepath.Join(home, "Videos/Tagged.mp4")
	ffmpeg(t, "-f", "lavfi", "-i", "color=red:size=64x64", "-frames:v", "1", art)
	clip(t, plain, "-t", "2", "-c:v", "libx264", "-level", "3.0", "-c:a", "aac")
	ffmpeg(t, "-i", plain, "-i", art, "-map", "0", "-map", "1", "-c", "copy", "-disposition:v:1", "attached_pic", tagged)
	artFirst(t, tagged)
	if got := codecNames(t, tagged); got != "png h264 aac" {
		t.Fatalf("the Source's streams are %s, want the cover art first: png h264 aac", got)
	}
	srv := serve(t, home)

	if got := probeOf(t, srv, "Videos/Tagged.mp4")["codecs"]; got != "avc1.64001e, mp4a.40.2" {
		t.Errorf("probed the codecs %v, want the video's: avc1.64001e, mp4a.40.2", got)
	}
	file, _ := streamOf(t, srv, "Videos/Tagged.mp4", 0)
	if got := codecNames(t, file); got != "h264 aac" {
		t.Errorf("the stream's streams are %s, want h264 aac", got)
	}
}

func TestStreamFromATimeHoldsThatTimesFrameAndSound(t *testing.T) {
	home, _ := newHome(t)
	// Keyframes every 2 s from each Source's start. The Matroska Source starts
	// 10 s in, as some remuxes do, and B-frames start the video's decode times
	// before its first frame's time.
	sources := map[string]float64{
		"Downloads/Movies/Late (2024)/Late.mkv": 10,
		"Downloads/Movies/Clip (2024)/Clip.mp4": 0,
	}
	for name, start := range sources {
		clip(t, filepath.Join(home, name), "-t", "8", "-c:v", "libx264", "-bf", "2", "-g", "48", "-keyint_min", "48", "-sc_threshold", "0",
			"-c:a", "aac", "-output_ts_offset", fmt.Sprint(start))
	}
	srv := serve(t, home)

	for name, start := range sources {
		from := start + 5.5
		file, _ := streamOf(t, srv, name, from)
		// From the keyframe at 4 s, a second or more before from, in the
		// Source's own time.
		src := packetTimes(t, filepath.Join(home, name), "V")
		want := src[slices.IndexFunc(src, func(pts float64) bool { return pts >= start+4 }):]
		if got := packetTimes(t, file, "v"); !slices.Equal(got, want) {
			t.Errorf("%s from %v s: the stream's video is at %s, want %s", name, from, brief(got), brief(want))
		}
		// WebKit plays a time only once every track has started there (#11).
		if got := packetTimes(t, file, "a"); len(got) == 0 || got[0] > from-1 {
			t.Errorf("%s from %v s: the stream's audio is at %s, want it to start a second or more before", name, from, brief(got))
		}
	}
}

func TestClosingTheStreamStopsItsFFmpeg(t *testing.T) {
	home, _ := newHome(t)
	// Over 60 MB, more than the pipe and the sockets between FFmpeg and the
	// page hold, so FFmpeg is still writing when the request closes.
	short, long := filepath.Join(t.TempDir(), "short.mkv"), filepath.Join(home, "Videos/Long.mkv")
	clip(t, short, "-t", "2", "-c:v", "libx264", "-preset", "ultrafast", "-qp", "1", "-c:a", "aac")
	ffmpeg(t, "-stream_loop", "199", "-i", short, "-c", "copy", long)
	srv := serve(t, home)

	res, err := http.Get(srv.URL + "/api/source/stream?" + url.Values{"path": {"Videos/Long.mkv"}}.Encode())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.CopyN(io.Discard, res.Body, 1<<20); err != nil {
		t.Fatalf("reading the stream: %v", err)
	}
	if !opened(long) {
		t.Fatal("nothing has the Source open while it streams")
	}
	res.Body.Close()
	for wait := time.Now().Add(5 * time.Second); opened(long); time.Sleep(50 * time.Millisecond) {
		if time.Now().After(wait) {
			t.Fatal("the Source is still open 5 s after its stream's request closed")
		}
	}
}

func TestThumbnailIsTheKeyframeAtOrBeforeTheTime(t *testing.T) {
	home, _ := newHome(t)
	// Keyframes every 2 s from each Source's start, and B-frames, which put a
	// keyframe's decode time before its own. The Matroska Source starts 10 s
	// in, as some remuxes do, and the HDR10 one is tone-mapped.
	every2s := []string{"-t", "8", "-g", "48", "-keyint_min", "48", "-sc_threshold", "0"}
	h264 := slices.Concat(every2s, []string{"-c:v", "libx264", "-bf", "2"})
	sources := map[string]struct {
		args  []string
		start float64 // where its time starts
		hdr   bool
	}{
		"Downloads/Movies/Clip (2024)/Clip.mkv": {h264, 0, false},
		"Downloads/Movies/Clip (2024)/Clip.mp4": {h264, 0, false},
		"Downloads/Movies/Late (2024)/Late.mkv": {slices.Concat(h264, []string{"-output_ts_offset", "10"}), 10, false},
		"Videos/HDR10.mkv": {slices.Concat(every2s, []string{"-c:v", "libx265", "-pix_fmt", "yuv420p10le",
			"-x265-params", "log-level=error:scenecut=0:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc",
			"-color_primaries", "bt2020", "-color_trc", "smpte2084", "-colorspace", "bt2020nc"}), 0, true},
	}
	for name, s := range sources {
		clip(t, filepath.Join(home, name), s.args...)
	}
	srv := serve(t, home)

	for name, s := range sources {
		src := filepath.Join(home, name)
		keyframes := keyframeTimes(t, src)
		// Its first frame, just before and just after the keyframe at 4 s,
		// between keyframes, and past its end.
		for _, at := range []float64{s.start, s.start + 3.95, s.start + 4.05, s.start + 5.5, s.start + 9} {
			want := keyframes[0]
			for _, k := range keyframes {
				if k <= at {
					want = k
				}
			}
			got, difference := shownFrame(t, thumbnailOf(t, srv, name, at), src)
			if got != want {
				t.Errorf("%s at %v s: the thumbnail shows the frame at %v s, want the keyframe at %v s", name, at, got, want)
			}
			// SDR shows as it is, but for JPEG's loss: a difference of 5 or so.
			// Tone-mapped, HDR10 is far from its frame as decoded: about 3,000,
			// where untouched it's about 200.
			if tonemapped := difference > 1000; tonemapped != s.hdr {
				t.Errorf("%s at %v s: the thumbnail differs from its frame by %v, want it tone-mapped: %v", name, at, difference, s.hdr)
			}
		}
	}
}

func TestThumbnailComesFromTheCache(t *testing.T) {
	home, _ := newHome(t)
	clip(t, filepath.Join(home, "Videos/Clip.mkv"), "-t", "4", "-c:v", "libx264")
	srv := serve(t, home)
	first := thumbnailOf(t, srv, "Videos/Clip.mkv", 2.5)

	// With no FFmpeg to run, only the cache can answer.
	path := os.Getenv("PATH")
	t.Setenv("PATH", "")
	if again := thumbnailOf(t, srv, "Videos/Clip.mkv", 2.5); !bytes.Equal(again, first) {
		t.Error("the thumbnail asked for again isn't the one made first")
	}

	// The cache, deleted, is made again as it's asked for. It's in app data,
	// which serve puts next to Home.
	if err := os.RemoveAll(filepath.Join(home, "../data/cache")); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", path)
	if remade := thumbnailOf(t, srv, "Videos/Clip.mkv", 2.5); !bytes.Equal(remade, first) {
		t.Error("the thumbnail made again isn't the one made first")
	}
	t.Setenv("PATH", "")
	if again := thumbnailOf(t, srv, "Videos/Clip.mkv", 2.5); !bytes.Equal(again, first) {
		t.Error("the thumbnail made again and asked for again isn't the one made first")
	}
}

func TestFramesAroundATimeAreWhereAMomentCanStartAndEnd(t *testing.T) {
	home, _ := newHome(t)
	// Keyframes 10 s apart, as most Sources in Home have them, in a Matroska
	// Source that starts 10 s in, as some remuxes do; B-frames, which show out
	// of their decode order; x265's open GOP, whose keyframes have leading
	// frames, decoded after them but shown before; no B-frames; video that
	// starts 3 s after the audio; and an MP4 cut mid-GOP by a stream copy, whose
	// edit list keeps its first keyframe from showing.
	sources := map[string]struct {
		args       []string
		cut        float64 // where the copy starts, for a Source cut from another
		start      float64 // where its video's time starts
		everyFrame bool    // a clean end
	}{
		"Downloads/Movies/Late (2024)/Late.mkv": {args: []string{"-t", "25", "-c:v", "libx264", "-g", "240", "-keyint_min", "240", "-sc_threshold", "0", "-output_ts_offset", "10"}, start: 10},
		"Downloads/Movies/Clip (2024)/Clip.mp4": {args: []string{"-t", "8", "-c:v", "libx264", "-bf", "3", "-g", "48"}},
		"Videos/Open GOP.mp4":                   {args: []string{"-t", "8", "-c:v", "libx265", "-x265-params", "log-level=error:keyint=48:min-keyint=48:scenecut=0:open-gop=1"}},
		"Videos/No B-frames.mp4":                {args: []string{"-t", "8", "-c:v", "libx264", "-bf", "0", "-g", "48"}, everyFrame: true},
		"Videos/Audio first.mkv":                {args: []string{"-t", "8", "-c:v", "libx264", "-g", "48", "-vf", "setpts=PTS+3/TB"}, start: 3},
		"Videos/Cut.mp4":                        {args: []string{"-t", "8", "-c:v", "libx264", "-bf", "3", "-g", "48"}, cut: 0.5},
	}
	for name, s := range sources {
		path := filepath.Join(home, name)
		if s.cut == 0 {
			clip(t, path, s.args...)
			continue
		}
		whole := filepath.Join(t.TempDir(), "whole.mp4")
		clip(t, whole, s.args...)
		ffmpeg(t, "-ss", fmt.Sprint(s.cut), "-i", whole, "-c", "copy", path)
	}
	if leadingFrames(t, filepath.Join(home, "Videos/Open GOP.mp4")) == 0 {
		t.Fatal("x265 gave the open GOP's keyframes no leading frames, which leaves them untested")
	}
	srv := serve(t, home)

	for name, s := range sources {
		src := filepath.Join(home, name)
		keyframes, ends := keyframeTimes(t, src), cleanEnds(t, src)
		if s.everyFrame {
			ends = packetTimes(t, src, "V")
		}
		// Before its start, its first frame, before its first keyframe that
		// shows (in the cut), just before a keyframe (on x265's leading frames),
		// on one, between keyframes, and past its end.
		for _, at := range []float64{s.start - 5, s.start, s.start + 1.2, s.start + 3.9, s.start + 4, s.start + 5.5, s.start + 9.95, s.start + 15, s.start + 30} {
			got := framesOf(t, srv, name, at)
			// From the keyframe at or before at, or else the first, through at.
			from := keyframes[0]
			for _, k := range keyframes {
				if k <= at {
					from = k
				}
			}
			wantKeyframes, wantEnds := between(keyframes, from, max(from, at)), between(ends, from, at)
			if !slices.Equal(got.Keyframes, wantKeyframes) || got.CleanEnds == nil || !slices.Equal(got.CleanEnds, wantEnds) {
				t.Errorf("%s around %v s: keyframes at %s and clean ends at %s, want keyframes at %s and clean ends at %s",
					name, at, brief(got.Keyframes), brief(got.CleanEnds), brief(wantKeyframes), brief(wantEnds))
			}
		}
	}
}

// probeOf asks the server how the Trimmer opens the Source at path, and
// returns its JSON.
func probeOf(t *testing.T, srv *httptest.Server, path string) (p map[string]any) {
	t.Helper()
	if err := json.Unmarshal([]byte(get(t, srv.URL+"/api/source?"+url.Values{"path": {path}}.Encode(), "application/json")), &p); err != nil {
		t.Fatal(err)
	}
	return p
}

// streamOf fetches the server's stream of the Source at path from the time
// from into a file, and returns the file and what's in it.
func streamOf(t *testing.T, srv *httptest.Server, path string, from float64) (string, []byte) {
	t.Helper()
	body := []byte(get(t, srv.URL+"/api/source/stream?"+url.Values{"path": {path}, "from": {fmt.Sprint(from)}}.Encode(), "video/mp4"))
	file := filepath.Join(t.TempDir(), "stream.mp4")
	if err := os.WriteFile(file, body, 0o644); err != nil {
		t.Fatal(err)
	}
	return file, body
}

// thumbnailOf fetches the server's thumbnail of the Source at path for the
// time at.
func thumbnailOf(t *testing.T, srv *httptest.Server, path string, at float64) []byte {
	t.Helper()
	return []byte(get(t, srv.URL+"/api/source/thumbnail?"+url.Values{"path": {path}, "at": {fmt.Sprint(at)}}.Encode(), "image/jpeg"))
}

// framesOf asks the server for the keyframes and clean ends of the Source at
// path around the time at.
func framesOf(t *testing.T, srv *httptest.Server, path string, at float64) (f struct{ Keyframes, CleanEnds []float64 }) {
	t.Helper()
	if err := json.Unmarshal([]byte(get(t, srv.URL+"/api/source/frames?"+url.Values{"path": {path}, "at": {fmt.Sprint(at)}}.Encode(), "application/json")), &f); err != nil {
		t.Fatal(err)
	}
	return f
}

// shownFrame finds the frame of the video in file that image shows, the one
// it differs least from, and returns that frame's time and the difference,
// as psnr's mean squared error.
func shownFrame(t *testing.T, image []byte, file string) (time, difference float64) {
	t.Helper()
	still := filepath.Join(t.TempDir(), "image")
	if err := os.WriteFile(still, image, 0o644); err != nil {
		t.Fatal(err)
	}
	// psnr compares each of the video's frames, in order, with the image, and
	// writes a line for each: "n:1 mse_avg:4.41 …".
	out, err := exec.Command("ffmpeg", "-v", "error", "-i", file, "-loop", "1", "-i", still,
		"-lavfi", "[0:V:0][1:v]psnr=stats_file=-:shortest=1", "-f", "null", "-").Output()
	if err != nil {
		t.Fatalf("ffmpeg comparing %s with an image: %v", file, err)
	}
	best, least := -1, math.Inf(1)
	for i, line := range slices.Collect(strings.Lines(string(out))) {
		mse, err := strconv.ParseFloat(strings.TrimPrefix(strings.Fields(line)[1], "mse_avg:"), 64)
		if err != nil {
			t.Fatalf("reading psnr's %q: %v", line, err)
		}
		if mse < least {
			best, least = i, mse
		}
	}
	if best < 0 {
		t.Fatalf("psnr compared no frames of %s", file)
	}
	return packetTimes(t, file, "V")[best], least
}

// keyframeTimes reads the presentation times of the keyframes in file's
// first video that isn't cover art, in order, but for those an edit list
// keeps from showing, which ffprobe flags D.
func keyframeTimes(t *testing.T, file string) []float64 {
	t.Helper()
	out, err := exec.Command("ffprobe", "-v", "error", "-select_streams", "V:0",
		"-show_entries", "packet=pts_time,flags", "-of", "csv=p=0", file).Output()
	if err != nil {
		t.Fatalf("ffprobe %s: %v", file, err)
	}
	var times []float64
	for line := range strings.FieldsSeq(string(out)) {
		pts, flags, _ := strings.Cut(line, ",")
		if !strings.HasPrefix(flags, "K") || strings.Contains(flags, "D") {
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

// cleanEnds reads the times of the frames a copy of file's first video that
// isn't cover art, from its start, can end on, in order: the frames shown
// last where every frame decoded so far shows before every frame still to
// come (#10).
func cleanEnds(t *testing.T, file string) []float64 {
	t.Helper()
	decoded := decodedTimes(t, file, "V")
	var ends []float64
	shown := math.Inf(-1) // the last frame shown of those decoded so far
	for i, pts := range decoded {
		shown = max(shown, pts)
		if i == len(decoded)-1 || shown < slices.Min(decoded[i+1:]) {
			ends = append(ends, shown)
		}
	}
	return ends
}

// leadingFrames counts the frames of file's first video that isn't cover art
// that are decoded right after a keyframe but shown before it, as in x265's
// open GOP.
func leadingFrames(t *testing.T, file string) (n int) {
	t.Helper()
	decoded := decodedTimes(t, file, "V")
	for _, k := range keyframeTimes(t, file) {
		for _, pts := range decoded[slices.Index(decoded, k)+1:] {
			if pts > k {
				break
			}
			n++
		}
	}
	return n
}

// between keeps the times from from through to.
func between(times []float64, from, to float64) []float64 {
	return slices.DeleteFunc(slices.Clone(times), func(time float64) bool { return time < from || time > to })
}

// opened reports whether a process, such as an FFmpeg streaming it, has file
// open.
func opened(file string) bool {
	fds, _ := filepath.Glob("/proc/[0-9]*/fd/*")
	for _, fd := range fds {
		if target, err := os.Readlink(fd); err == nil && target == file {
			return true
		}
	}
	return false
}

// ffmpeg runs FFmpeg with args, in the folder of the file it writes last,
// which it makes.
func ffmpeg(t *testing.T, args ...string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(args[len(args)-1]), 0o755); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("ffmpeg", append([]string{"-nostdin", "-v", "error"}, args...)...).CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg %s: %v\n%s", strings.Join(args, " "), err, out)
	}
}

// clip makes a video at path from a 24 fps test pattern and a tone. args,
// between the inputs and the file, give its length and codecs.
func clip(t *testing.T, path string, args ...string) {
	t.Helper()
	ffmpeg(t, slices.Concat([]string{"-f", "lavfi", "-i", "testsrc2=size=320x240:rate=24",
		"-f", "lavfi", "-i", "sine=sample_rate=48000"}, args, []string{path})...)
}

// artFirst moves the udta box of the MP4 file, which holds its cover art, from
// after its tracks to before them, as some taggers write it. FFmpeg then lists
// the art before the video. The boxes all stay inside the moov, so the file's
// offsets still point at its media.
func artFirst(t *testing.T, file string) {
	t.Helper()
	b, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	for _, box := range mp4Boxes(b) {
		if string(box[4:8]) != "moov" {
			continue
		}
		parts := map[string][]byte{}
		for _, child := range mp4Boxes(box[8:]) {
			kind := string(child[4:8])
			if kind != "mvhd" && kind != "udta" {
				kind = "rest"
			}
			parts[kind] = append(parts[kind], child...)
		}
		copy(box[8:], slices.Concat(parts["mvhd"], parts["udta"], parts["rest"]))
	}
	if err := os.WriteFile(file, b, 0o644); err != nil {
		t.Fatal(err)
	}
}

// boxTypes lists the types of the boxes in b, a run of MP4 boxes.
func boxTypes(b []byte) []string {
	var types []string
	for _, box := range mp4Boxes(b) {
		types = append(types, string(box[4:8]))
	}
	return types
}

// codecNames lists the codecs of the streams in file, in order, with ffprobe.
func codecNames(t *testing.T, file string) string {
	t.Helper()
	out, err := exec.Command("ffprobe", "-v", "error", "-show_entries", "stream=codec_name", "-of", "csv=p=0", file).Output()
	if err != nil {
		t.Fatalf("ffprobe %s: %v", file, err)
	}
	return strings.Join(strings.Fields(string(out)), " ")
}

// carried describes the streams in file as ffprobe reads them, in order: each
// one's sample entry, an audio stream's channel layout, and the bit depth when
// ffprobe tells it, such as "avc1 8, mp4a 5.1".
func carried(t *testing.T, file string) string {
	t.Helper()
	out, err := exec.Command("ffprobe", "-v", "error", "-show_entries", "stream=codec_tag_string,channel_layout,bits_per_raw_sample", "-of", "csv=p=0", file).Output()
	if err != nil {
		t.Fatalf("ffprobe %s: %v", file, err)
	}
	var streams []string
	for line := range strings.Lines(strings.TrimSpace(string(out))) {
		streams = append(streams, strings.Join(slices.DeleteFunc(strings.Split(strings.TrimSpace(line), ","), func(field string) bool { return field == "N/A" }), " "))
	}
	return strings.Join(streams, ", ")
}

// audioHash hashes the packets of the audio track track in file, counted from
// 0, as they are.
func audioHash(t *testing.T, file string, track int) string {
	t.Helper()
	out, err := exec.Command("ffmpeg", "-v", "error", "-i", file, "-map", fmt.Sprint("0:a:", track), "-c", "copy", "-f", "streamhash", "-hash", "md5", "-").Output()
	if err != nil {
		t.Fatalf("ffmpeg %s: %v", file, err)
	}
	return strings.TrimSpace(string(out))
}

// packetTimes reads the presentation times of the packets in file's first
// stream of the type ffprobe's spec selects ("v", "V" for video that isn't
// cover art, "a"), in order.
func packetTimes(t *testing.T, file, spec string) []float64 {
	t.Helper()
	times := decodedTimes(t, file, spec)
	slices.Sort(times)
	return times
}

// decodedTimes reads the presentation times of the packets in file's first
// stream of the type ffprobe's spec selects, in decode order, as ffprobe
// lists them.
func decodedTimes(t *testing.T, file, spec string) []float64 {
	t.Helper()
	out, err := exec.Command("ffprobe", "-v", "error", "-select_streams", spec+":0",
		"-show_entries", "packet=pts_time", "-of", "csv=p=0", file).Output()
	if err != nil {
		t.Fatalf("ffprobe %s: %v", file, err)
	}
	var times []float64
	for line := range strings.FieldsSeq(string(out)) {
		pts, _, _ := strings.Cut(line, ",") // side data adds fields
		time, err := strconv.ParseFloat(pts, 64)
		if err != nil {
			t.Fatalf("ffprobe %s: %v", file, err)
		}
		times = append(times, time)
	}
	return times
}

// brief describes times by their count, first and last.
func brief(times []float64) string {
	if len(times) == 0 {
		return "nothing"
	}
	return fmt.Sprintf("%d packets from %v to %v s", len(times), times[0], times[len(times)-1])
}
