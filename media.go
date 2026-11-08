package main

import (
	"bytes"
	"cmp"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"math/bits"
	"os"
	"os/exec"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

// A probe is how the Trimmer opens a Source.
type probe struct {
	Duration float64 `json:"duration"` // to its end, in seconds of its own time
	// The stream's codecs for MediaSource and its frames a second, when the
	// Trimmer plays the Source; else why not, to end "The Trimmer can't play
	// this Source: …".
	Codecs    string  `json:"codecs,omitempty"`
	FrameRate float64 `json:"frameRate,omitempty"`
	CantPlay  string  `json:"cantPlay,omitempty"`
	// Its audio tracks, in order: a stream carries one of them.
	AudioTracks []audioTrack `json:"audioTracks,omitempty"`
}

// An audioTrack is one of a Source's audio tracks, as the Trimmer's picker
// lists it.
type audioTrack struct {
	Language string `json:"language,omitempty"` // as the Source tags it, such as eng
	Codec    string `json:"codec"`              // as players name it, such as E-AC-3
	Channels int    `json:"channels"`
	Default  bool   `json:"default,omitempty"` // the one a stream carries unless asked for another
}

// audioCodecs names audio codecs as players do, by FFmpeg's name, where its
// name in capitals, up to any _, won't do: aac is AAC, pcm_s24le PCM.
var audioCodecs = map[string]string{"ac3": "AC-3", "eac3": "E-AC-3", "truehd": "TrueHD", "opus": "Opus", "vorbis": "Vorbis"}

// A probedStream is one of a Source's streams, as ffprobe describes it.
type probedStream struct {
	Index    int     `json:"index"` // among all the Source's streams
	Type     string  `json:"codec_type"`
	Codec    string  `json:"codec_name"`
	LongName string  `json:"codec_long_name"`
	Tag      string  `json:"codec_tag_string"` // its sample entry in an MP4, such as hev1
	Profile  string  `json:"profile"`
	Channels int     `json:"channels"`
	Bits     int     `json:"bits_per_raw_sample,string"` // a FLAC's bit depth
	BFrames  int     `json:"has_b_frames"`               // how many frames B-frames hold back
	Transfer string  `json:"color_transfer"`             // such as smpte2084, HDR10's
	Start    float64 `json:"start_time,string"`          // in seconds of the Source's own time
	// Disposition says which audio track is the default, and which video is
	// cover art.
	Disposition struct {
		Default     int `json:"default"`
		AttachedPic int `json:"attached_pic"`
	} `json:"disposition"`
	Tags struct {
		Language string `json:"language"`
	} `json:"tags"`
	// Frames a second, as fractions such as "24000/1001": the average, and
	// the base rate for when ffprobe can't tell the average.
	AvgFrameRate  string `json:"avg_frame_rate"`
	BaseFrameRate string `json:"r_frame_rate"`

	ExtradataBytes int `json:"extradata_size"`
}

func (stream probedStream) frameLength() float64 {
	return 1 / cmp.Or(fraction(stream.AvgFrameRate), fraction(stream.BaseFrameRate))
}

// A source is a Source as ffprobe reads it, with the streams a Moment or the
// Trimmer takes from it.
type source struct {
	duration float64 // to its end, in seconds of its own time
	// The first video that isn't cover art, and the audio track a stream
	// carries: the default, the first with the default disposition, or else
	// the first, unless another is asked for. nil when it has none.
	video, audio *probedStream
	tracks       []probedStream // its audio tracks, in order
	// How much earlier than its time FFmpeg's -ss seeks: 3/23 s in Matroska
	// and WebM with B-frames (FFmpeg's ffmpeg_demux.c), so aimed that much
	// later, a seek lands on the keyframe at or before its time (#4). MP4
	// seeks by decode time, shifted by the video's first delay: exact but for
	// keyframes with leading frames, as in x265's open GOP, which a time up to
	// a few frames before them lands on (#11).
	seekEarly float64
}

// avcProfiles and aacProfiles hold the H.264 and AAC profiles that play
// untouched on the targets, by FFmpeg's name.
var (
	avcProfiles = map[string]bool{"Constrained Baseline": true, "Baseline": true, "Main": true, "High": true, "High 10": true}
	aacProfiles = map[string]bool{"LC": true, "HE-AAC": true, "HE-AACv2": true}
)

// untouched reports whether the stream s plays as it is on all three targets,
// Safari on the Mac and the iPhone and Chrome on the Mac (#13). A Moment copies
// such a stream and converts any other, and the Trimmer's stream carries what
// the Moment will, but for 24-bit FLAC (streamSource). A new device or browser
// changes this table, not the rule.
func untouched(s probedStream) bool {
	switch s.Codec {
	case "h264":
		return avcProfiles[s.Profile]
	case "aac":
		return aacProfiles[s.Profile]
	}
	return s.Codec == "hevc" || s.Codec == "av1" || s.Codec == "opus" || s.Codec == "flac"
}

// aacLayouts holds, by channel count, the layout audio converted to AAC needs
// set: without it, FFmpeg writes 5.1 from AC-3, E-AC-3 or DTS with a program
// config element, which MediaSource refuses (#11). 6.1 has no AAC layout, so
// it goes to 7.1, its back channel shared by both back speakers. Mono and
// stereo need none.
var aacLayouts = map[int]string{6: "5.1", 7: "7.1", 8: "7.1"}

// audioArgs are FFmpeg's output options for the audio stream a in a Moment: a
// copy when it plays untouched, else AAC from FFmpeg's own encoder with its
// channels kept, at 128 kbps for each channel it carries (#13).
func audioArgs(a probedStream) []string {
	if untouched(a) {
		return []string{"-c:a", "copy"}
	}
	channels, layout := a.Channels, aacLayouts[a.Channels]
	if layout == "7.1" {
		channels = 8
	}
	args := []string{"-c:a", "aac", "-b:a", fmt.Sprint(128*channels, "k")}
	if layout != "" {
		args = append(args, "-ch_layout", layout)
	}
	return args
}

// copyVideo are FFmpeg's output options that copy the video v into an MP4.
// HEVC from Matroska has no sample entry of its own, and MP4's default is
// hev1, which Safari won't play as a file. An MP4 Source's hev1 stays: its
// parameter sets may be in the stream alone, and retagged, its hvcC comes out
// empty (#11).
func copyVideo(v probedStream) []string {
	if v.Codec == "hevc" && v.Tag != "hev1" {
		return []string{"-c:v", "copy", "-tag:v", "hvc1"}
	}
	return []string{"-c:v", "copy"}
}

func momentVideo(video probedStream) []string {
	if !untouched(video) {
		return []string{"-vf", "format=p010le,hwupload", "-c:v", "hevc_vaapi", "-low_power", "1", "-rc_mode", "CQP", "-qp", "22",
			"-profile:v", "main10", "-tag:v", "hvc1", "-fps_mode", "passthrough"}
	}
	if video.Codec != "hevc" {
		return []string{"-c:v", "copy"}
	}
	options := []string{"-c:v", "copy", "-tag:v", "hvc1"}
	// An hvcC of 23 bytes or less holds no parameter sets; Annex B lets the muxer rebuild it from the stream's.
	if video.ExtradataBytes <= 23 {
		options = append(options, "-bsf:v", "hevc_mp4toannexb")
	}
	return options
}

// input is how FFmpeg and ffprobe read a Source: as the file the server opened
// and checked (sources.go), passed on as their first extra file, rather than by
// a path that a link could lead elsewhere by then.
const input = "file:/dev/fd/3"

// sourceReads holds what ffprobe read of each Source, by its path, size and
// modification time, so a stream of it, one per seek, starts without asking
// again: 0.1 to 0.25 s on the Umbrel.
//
// ponytail: never forgets a Source, a few hundred Sources in Home; an LRU if
// that grows.
var sourceReads sync.Map

// A readKey tells a Source apart from the file at its path before it was
// replaced.
type readKey struct {
	path        string
	size, mtime int64
}

// readSource asks ffprobe about the Source src, unless it asked already.
func readSource(ctx context.Context, src *os.File) (source, error) {
	stat, err := src.Stat()
	if err != nil {
		return source{}, err
	}
	key := readKey{src.Name(), stat.Size(), stat.ModTime().UnixNano()}
	if s, ok := sourceReads.Load(key); ok {
		return s.(source), nil
	}
	var out bytes.Buffer
	cmd := exec.CommandContext(ctx, "ffprobe", "-v", "error", "-of", "json", "-show_entries",
		"format=format_name,start_time,duration:stream=index,codec_type,codec_name,codec_long_name,codec_tag_string,extradata_size,profile,channels,bits_per_raw_sample,has_b_frames,color_transfer,start_time,avg_frame_rate,r_frame_rate:stream_disposition=default,attached_pic:stream_tags=language", input)
	cmd.ExtraFiles, cmd.Stdout = []*os.File{src}, &out
	if err := runFFmpeg(cmd); err != nil {
		return source{}, err
	}
	var info struct {
		Format struct {
			Name     string  `json:"format_name"`
			Start    float64 `json:"start_time,string"`
			Duration float64 `json:"duration,string"`
		} `json:"format"`
		Streams []probedStream `json:"streams"`
	}
	if err := json.Unmarshal(out.Bytes(), &info); err != nil {
		return source{}, fmt.Errorf("reading ffprobe: %w", err)
	}
	// ffprobe counts a Matroska Source's duration from 0, as its own time runs,
	// and any other's from its start.
	s := source{duration: info.Format.Duration}
	if info.Format.Name != "matroska,webm" {
		s.duration += info.Format.Start
	}
	for i, st := range info.Streams {
		switch {
		case s.video == nil && st.Type == "video" && st.Disposition.AttachedPic == 0:
			s.video = &info.Streams[i]
		case st.Type == "audio":
			s.tracks = append(s.tracks, st)
		}
		if st.BFrames > 0 && info.Format.Name == "matroska,webm" {
			s.seekEarly = 3.0 / 23
		}
	}
	if len(s.tracks) > 0 {
		s.audio = &s.tracks[max(0, slices.IndexFunc(s.tracks, func(a probedStream) bool { return a.Disposition.Default == 1 }))]
	}
	sourceReads.Store(key, s)
	return s, nil
}

// cantPlay says why the Trimmer can't play s, or "" when it can: it plays the
// video both Mac browsers decode, which is what plays untouched, and VP9.
func (s source) cantPlay() string {
	switch {
	case s.video == nil:
		return "it has no video"
	case s.video.Codec == "h264" && !untouched(*s.video):
		return "its video is H.264 " + s.video.Profile
	case !untouched(*s.video) && s.video.Codec != "vp9":
		return "its video is " + s.video.LongName
	}
	return ""
}

// probeSource asks ffprobe how the Trimmer opens the Source src, and its
// stream for the codec strings MediaSource needs.
func probeSource(ctx context.Context, src *os.File) (probe, error) {
	s, err := readSource(ctx, src)
	if err != nil {
		return probe{}, err
	}
	p := probe{Duration: s.duration, CantPlay: s.cantPlay()}
	if p.CantPlay != "" {
		return p, nil
	}
	p.FrameRate = cmp.Or(fraction(s.video.AvgFrameRate), fraction(s.video.BaseFrameRate))
	for _, a := range s.tracks {
		codec, _, _ := strings.Cut(a.Codec, "_")
		p.AudioTracks = append(p.AudioTracks, audioTrack{a.Tags.Language, cmp.Or(audioCodecs[a.Codec], strings.ToUpper(codec)), a.Channels, a.Index == s.audio.Index})
	}
	// The stream's start, up to its moov, which describes its tracks.
	ctx, stop := context.WithCancel(ctx)
	defer stop()
	start := &untilMoov{stop: stop}
	if err := streamSource(ctx, src, s, 0, start); err != nil {
		return probe{}, err
	}
	p.Codecs, err = codecs(start.header)
	return p, err
}

// streamSource writes the Source src, which ffprobe read as s, to w as
// fragmented MP4 in the Source's own time (#11, ADR-0003), until it ends or ctx
// is done, so that the time from, in seconds of that time, plays. The video is
// copied and the audio track s.audio carried as a Moment carries it. ctx's end
// kills its FFmpeg, and isn't an error.
func streamSource(ctx context.Context, src *os.File, s source, from float64, w io.Writer) error {
	args := []string{"-nostdin", "-v", "error"}
	// From a keyframe a second or more early: on an MP4, -ss picks the keyframe
	// by its decode time, which can come after from, and WebKit plays a time
	// only once every track has started there (#11). -seek_timestamp puts -ss
	// in the Source's own time rather than from its start.
	if from > 1 {
		args = append(args, "-seek_timestamp", "1", "-ss", strconv.FormatFloat(from-1, 'f', -1, 64))
	}
	args = append(args, "-copyts", "-i", input, "-map", fmt.Sprint("0:", s.video.Index), "-map_chapters", "-1")
	args = append(args, copyVideo(*s.video)...)
	if s.audio != nil {
		audio := audioArgs(*s.audio)
		// WebKit's MediaSource stalls on FLAC deeper than 16 bits, which plays
		// as a file, so only the Trimmer turns it 16-bit (#11). It's the one
		// stream that isn't as a Save would carry it, as ADR-0003 has it.
		if s.audio.Codec == "flac" && s.audio.Bits > 16 {
			audio = []string{"-c:a", "flac", "-sample_fmt", "s16"}
		}
		args = append(append(args, "-map", fmt.Sprint("0:", s.audio.Index)), audio...)
	}
	cmd := exec.CommandContext(ctx, "ffmpeg", append(args,
		// All three keep the Source's own time; without any one of them the
		// stream starts at 0.
		"-avoid_negative_ts", "disabled", "-use_editlist", "0", "-movflags", "frag_keyframe+empty_moov+default_base_moof+frag_discont",
		// Fragments of a second at most, so the first frame shows within one.
		"-frag_duration", "1000000", "-f", "mp4", "pipe:1")...)
	cmd.ExtraFiles, cmd.Stdout = []*os.File{src}, w
	if err := runFFmpeg(cmd); err != nil && ctx.Err() == nil {
		return err
	}
	return nil
}

// hdrTransfers holds the transfers of HDR video, by FFmpeg's name: PQ, which
// HDR10 and Dolby Vision's base layer use, and HLG.
var hdrTransfers = map[string]bool{"smpte2084": true, "arib-std-b67": true}

// grabFrame makes a JPEG, width pixels wide at most, of the keyframe at or before the
// time at, in seconds of its own time, in the Source src. A keyframe decodes
// alone, in a fraction of a second, where decoding up to the frame at at could
// take 6 s (#11). HDR is tone-mapped to SDR, without which it looks flat.
func grabFrame(ctx context.Context, src *os.File, at float64, width int) ([]byte, error) {
	s, err := readSource(ctx, src)
	if err != nil {
		return nil, err
	}
	if s.video == nil {
		return nil, errors.New("it has no video")
	}
	// In the shape it plays in.
	filters := fmt.Sprintf("scale=w='trunc(min(%d,iw*sar)/2)*2':h='trunc(ow/dar/2)*2'", width)
	if hdrTransfers[s.video.Transfer] {
		// After scaling, so the CPU tone-maps width pixels across. BT.2020 is
		// set, which HDR always is, since zscale needs it and some files tag
		// their transfer alone.
		filters += ",setparams=color_primaries=bt2020:colorspace=bt2020nc:color_trc=" + s.video.Transfer +
			",zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p"
	}
	var jpeg bytes.Buffer
	// -noaccurate_seek starts from the keyframe, and -fps_mode passthrough
	// writes it, rather than the frame FFmpeg would decode up to at (#11).
	// Frame threads would decode several frames to give the first: at 4K, a
	// third longer than slice threads, with twice the CPU.
	cmd := exec.CommandContext(ctx, "ffmpeg", "-nostdin", "-v", "error", "-thread_type", "slice",
		"-seek_timestamp", "1", "-ss", strconv.FormatFloat(at+s.seekEarly, 'f', -1, 64), "-noaccurate_seek", "-i", input,
		"-map", fmt.Sprint("0:", s.video.Index), "-frames:v", "1", "-fps_mode", "passthrough",
		"-vf", filters, "-q:v", "5", "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1")
	cmd.ExtraFiles, cmd.Stdout = []*os.File{src}, &jpeg
	if err := runFFmpeg(cmd); err != nil {
		return nil, err
	}
	if jpeg.Len() == 0 {
		return nil, fmt.Errorf("FFmpeg found no frame at %v s", at)
	}
	return jpeg.Bytes(), nil
}

// frames are where a Moment can start and end, in seconds of its Source's own
// time: on a keyframe (#14), and on a clean end, a frame a copy can end on
// (#10).
type frames struct {
	Keyframes []float64 `json:"keyframes"`
	CleanEnds []float64 `json:"cleanEnds"`
	// Where a copy that ends on the latest clean end stops (cutMoment): a
	// decode time between the last packet it takes and the next, and when its
	// frame stops showing, the next frame's time. +Inf where the Source ends.
	decodeStop, frameEnd float64
}

// framesAround lists the frames of the Source opened where a Moment can start and
// end around the time at, in seconds of its own time: from the keyframe at or
// before at, or else its first, through the time to. With B-frames, a copy
// ends cleanly only where every frame decoded so far shows before every frame
// still to come; without them, on every frame (#10), as on every frame of
// video a Moment converts. One ffprobe reads its
// packets from a keyframe a second or more before at to 2 s past to, rather
// than an index of the whole Source, which takes a minute (#11).
func framesAround(ctx context.Context, opened *os.File, at, to float64) (frames, error) {
	probed, failure := readSource(ctx, opened)
	if failure != nil {
		return frames{}, failure
	}
	if probed.video == nil {
		return frames{}, errors.New("it has no video")
	}
	// Before the video starts, which can be seconds after the audio, nothing is
	// read.
	read := max(at, probed.video.Start)
	var output bytes.Buffer
	// -read_intervals starts on the keyframe at or before its start, but on an
	// MP4 by decode time, which lands a few frames late on a keyframe with
	// leading frames (#11): hence a second early. Frames show at most half a
	// second out of decode order (#10), so 2 s past to tells which are clean
	// ends up to to.
	command := exec.CommandContext(ctx, "ffprobe", "-v", "error", "-select_streams", fmt.Sprint(probed.video.Index),
		"-read_intervals", strconv.FormatFloat(read-1, 'f', -1, 64)+"%"+strconv.FormatFloat(max(read, to)+2, 'f', -1, 64),
		"-show_entries", "packet=pts_time,dts_time,flags", "-of", "csv=p=0", input)
	command.ExtraFiles, command.Stdout = []*os.File{opened}, &output
	if failure := runFFmpeg(command); failure != nil {
		return frames{}, failure
	}
	// When each packet shows, and when it's decoded, in decode order, from the
	// first keyframe. An MP4 cut mid-GOP has its edit list start after a
	// keyframe, and ffprobe flags the packets before the start D: they never
	// show, and nothing a Moment starts on comes before them.
	var decoded, decodedAt, keyframes []float64
	for line := range strings.FieldsSeq(output.String()) {
		pts, rest, _ := strings.Cut(line, ",")
		dts, flags, _ := strings.Cut(rest, ",")
		time, failure := strconv.ParseFloat(pts, 64)
		key := strings.HasPrefix(flags, "K")
		if failure != nil || strings.Contains(flags, "D") || len(decoded) == 0 && !key {
			continue // shows at no time, or can't be decoded
		}
		decodedTime, failure := strconv.ParseFloat(dts, 64)
		if failure != nil {
			decodedTime = math.NaN() // which no copy ends by
		}
		decoded, decodedAt = append(decoded, time), append(decodedAt, decodedTime)
		if key {
			keyframes = append(keyframes, time)
		}
	}
	if len(keyframes) == 0 {
		return frames{}, fmt.Errorf("FFmpeg found no keyframe around %v s", at)
	}
	from := keyframes[0]
	for _, keyframe := range keyframes {
		if keyframe <= at {
			from = keyframe
		}
	}
	// The frame shown first of those decoded after each packet. Past the
	// packets read, the Source has ended, or frames show over a second after
	// to.
	firstAfter := make([]float64, len(decoded))
	for i, first := len(decoded)-1, math.Inf(1); i >= 0; i-- {
		firstAfter[i], first = first, min(first, decoded[i])
	}
	found := frames{CleanEnds: []float64{}}
	if !untouched(*probed.video) {
		shownOrder := slices.Sorted(slices.Values(decoded))
		for index, shown := range shownOrder {
			if from <= shown && shown <= to {
				found.CleanEnds, found.decodeStop, found.frameEnd = append(found.CleanEnds, shown), math.Inf(1), math.Inf(1)
				if index+1 < len(shownOrder) {
					found.frameEnd = shownOrder[index+1]
				}
			}
		}
	} else {
		last := math.Inf(-1) // the frame shown last of those decoded so far
		for i, shown := range decoded {
			last = max(last, shown)
			if from <= last && last <= to && last < firstAfter[i] {
				stop := math.Inf(1)
				if i+1 < len(decoded) {
					stop = (decodedAt[i] + decodedAt[i+1]) / 2
				}
				found.CleanEnds, found.decodeStop, found.frameEnd = append(found.CleanEnds, last), stop, firstAfter[i]
			}
		}
	}
	found.Keyframes = slices.DeleteFunc(keyframes, func(keyframe float64) bool { return keyframe < from || keyframe > max(from, to) })
	return found, nil
}

// cutMoment writes to file the Moment of the Source opened, which ffprobe read
// as probed, as a plain MP4 with its index first (#10): its video and the audio
// track probed.audio, carried as streamSource carries them, from the keyframe at or
// before start through the clean end at or before end, in seconds of the
// Source's own time (#4, #14). It returns the keyframe's time.
//
// Of the Source's tags, only the audio's language comes along, so no title, no
// encoder and no phone's location (#10). The Moment's own say when it was
// saved, and where it came from (ADR-0002): the Source, named name, at path in
// Home, the Moment's start, the end of its last frame, and its audio track,
// counted from 0.
func cutMoment(ctx context.Context, opened *os.File, probed source, name, path string, start, end float64, file string, progress func(percent int)) (key, lastFrame float64, failure error) {
	if probed.video == nil {
		return 0, 0, errors.New("it has no video")
	}
	first, failure := framesAround(ctx, opened, start, start)
	if failure != nil {
		return 0, 0, failure
	}
	last, failure := framesAround(ctx, opened, end, end)
	if failure != nil {
		return 0, 0, failure
	}
	key, lastIndex := first.Keyframes[0], len(last.CleanEnds)-1
	if lastIndex < 0 || last.CleanEnds[lastIndex] < key {
		return 0, 0, fmt.Errorf("it has no frame from %v s through %v s", start, end)
	}
	lastFrame = last.CleanEnds[lastIndex]
	stop, frameEnd := last.decodeStop, last.frameEnd
	if math.IsNaN(stop) {
		return 0, 0, fmt.Errorf("FFmpeg can't tell when the frame at %v s is decoded", lastFrame)
	}
	if math.IsInf(frameEnd, 1) { // the Source's last frame, a frame long
		frameEnd = lastFrame + probed.video.frameLength()
	}
	seconds := func(at float64) string { return strconv.FormatFloat(at, 'f', -1, 64) }
	// Each input from the keyframe: aimed a millisecond into its frame, and as
	// much later as -ss lands before its time (source.seekEarly), which
	// -itsoffset takes off again, so that it lands at 0 (#4).
	early := probed.seekEarly + 0.001
	from := []string{"-seek_timestamp", "1", "-ss", seconds(key + early), "-itsoffset", seconds(early)}
	// The video is read up to the first packet decoded after the end's frame:
	// an input's -t counts by decode time, which B-frames put before a frame's
	// own. The output's -t stops the sound at the first audio frame after the
	// end's frame, by its own time; a -t for both would stop it as much early
	// (#10).
	args := slices.Concat([]string{"-nostdin", "-v", "error"}, from)
	if !untouched(*probed.video) {
		// Decoded from the keyframe itself, which an accurate seek to just past it would drop.
		args = append([]string{"-vaapi_device", "/dev/dri/renderD128"}, append(args, "-noaccurate_seek")...)
	}
	if !math.IsInf(stop, 1) {
		args = append(args, "-t", seconds(stop-key))
	}
	args = append(args, "-i", input)
	streams := slices.Concat([]string{"-map", fmt.Sprint("0:", probed.video.Index), "-map_chapters", "-1"}, momentVideo(*probed.video))
	// creation_time in FFmpeg's own form, to the microsecond.
	tags := []string{"-map_metadata", "-1", "-metadata", "creation_time=" + time.Now().UTC().Format("2006-01-02T15:04:05.000000Z07:00"),
		"-metadata", "moments.source_name=" + name, "-metadata", "moments.source_path=" + path, "-metadata", "moments.start=" + seconds(key)}
	if probed.audio != nil {
		args = slices.Concat(args, from, []string{"-i", input})
		streams = slices.Concat(streams, []string{"-map", fmt.Sprint("1:", probed.audio.Index)}, audioArgs(*probed.audio))
		tags = append(tags, "-metadata", "moments.audio_track="+strconv.Itoa(slices.IndexFunc(probed.tracks, func(track probedStream) bool { return track.Index == probed.audio.Index })))
		if probed.audio.Tags.Language != "" {
			tags = append(tags, "-metadata:s:a:0", "language="+probed.audio.Tags.Language)
		}
	}
	// ponytail: a Moment through the Source's last frame has no end tag when
	// ffprobe can't tell the frame rate; the Source's duration if one turns up.
	if !math.IsInf(frameEnd, 1) {
		streams = append(streams, "-t", seconds(frameEnd-key))
		tags = append(tags, "-metadata", "moments.end="+seconds(frameEnd))
	}
	// A camera's timecode would come along as a track of its own. With
	// use_metadata_tags, the MP4 holds tags under any key, rather than
	// iTunes' few.
	command := exec.CommandContext(ctx, "ffmpeg", slices.Concat(args, streams, tags, []string{"-write_tmcd", "0", "-strict", "unofficial", "-movflags", "+faststart+use_metadata_tags",
		"-progress", "pipe:1", "-stats_period", "0.1", "-f", "mp4", "-y", "file:" + file})...)
	length := frameEnd - key
	if math.IsInf(length, 1) {
		length = lastFrame - key
	}
	command.ExtraFiles, command.Stdout = []*os.File{opened}, &progressLines{length: length, report: progress}
	if failure := runFFmpeg(command); failure != nil {
		return 0, 0, failure
	}
	if probed.audio != nil && probed.audio.Codec == "flac" {
		return key, lastFrame, unknownFLACFrameSizes(file)
	}
	return key, lastFrame, nil
}

// Apple's FLAC decoder fails on a frame larger than STREAMINFO says, which some releases understate.
func unknownFLACFrameSizes(file string) (failure error) {
	defer func() {
		if recover() != nil {
			failure = errors.New("the Moment's FLAC sample entry is cut short")
		}
	}()
	moment, failure := os.OpenFile(file, os.O_RDWR, 0)
	if failure != nil {
		return failure
	}
	defer moment.Close()
	header := make([]byte, 8)
	for offset := int64(0); ; {
		if _, failure := moment.ReadAt(header, offset); failure != nil {
			return failure
		}
		size := int64(binary.BigEndian.Uint32(header))
		if string(header[4:]) != "moov" {
			offset += size
			continue
		}
		moov := make([]byte, size)
		if _, failure := moment.ReadAt(moov, offset); failure != nil {
			return failure
		}
		for _, trak := range mp4Boxes(moov[8:]) {
			if string(trak[4:8]) != "trak" {
				continue
			}
			stsd := trak[8:]
			for _, kind := range []string{"mdia", "minf", "stbl", "stsd"} {
				stsd = mp4Box(stsd, kind)
			}
			if entry := mp4Boxes(stsd[8:])[0]; string(entry[4:8]) == "fLaC" {
				streamInfo := mp4Box(entry[36:], "dfLa")[8:]
				clear(streamInfo[4:10])
			}
		}
		_, failure = moment.WriteAt(moov, offset)
		return failure
	}
}

type progressLines struct {
	length      float64
	report      func(percent int)
	partialLine []byte
}

func (lines *progressLines) Write(chunk []byte) (int, error) {
	lines.partialLine = append(lines.partialLine, chunk...)
	for {
		line, rest, whole := bytes.Cut(lines.partialLine, []byte("\n"))
		if !whole {
			return len(chunk), nil
		}
		lines.partialLine = rest
		written, isTime := bytes.CutPrefix(line, []byte("out_time_us="))
		if microseconds, err := strconv.ParseFloat(string(written), 64); isTime && err == nil && lines.length > 0 {
			lines.report(int(min(max(microseconds/1e6/lines.length, 0), 1) * 100))
		}
	}
}

func checkMoment(ctx context.Context, file string, lastFrame, frameLength float64) error {
	var output bytes.Buffer
	command := exec.CommandContext(ctx, "ffprobe", "-v", "error", "-select_streams", "V:0",
		"-show_entries", "packet=pts_time,flags", "-of", "csv=p=0", "file:"+file)
	command.Stdout = &output
	if err := runFFmpeg(command); err != nil {
		return err
	}
	packets := strings.Fields(output.String())
	if len(packets) == 0 {
		return errors.New("it has no video")
	}
	lastShown := math.Inf(-1)
	for index, packet := range packets {
		pts, flags, _ := strings.Cut(packet, ",")
		time, err := strconv.ParseFloat(pts, 64)
		if index == 0 && !strings.HasPrefix(flags, "K") {
			return errors.New("starts on a frame that isn't a keyframe")
		}
		if index == 0 && (err != nil || math.Abs(time) > 0.001) {
			return fmt.Errorf("starts at %s s, not 0", pts)
		}
		if err == nil && !strings.Contains(flags, "D") {
			lastShown = max(lastShown, time)
		}
	}
	framesOff := int(math.Round((lastShown - lastFrame) / frameLength))
	frames := "frames"
	if framesOff == 1 || framesOff == -1 {
		frames = "frame"
	}
	switch {
	case framesOff > 0:
		return fmt.Errorf("ends %d %s after the mark", framesOff, frames)
	case framesOff < 0:
		return fmt.Errorf("ends %d %s before the mark", -framesOff, frames)
	}
	return nil
}

// untilMoov keeps the start of a stream written to it, and calls stop once
// that holds the stream's moov. It's no bytes.Buffer, whose ReadFrom io.Copy
// would call instead of Write, to read the whole stream.
type untilMoov struct {
	header []byte
	stop   context.CancelFunc
}

func (u *untilMoov) Write(b []byte) (int, error) {
	if mp4Box(u.header, "moov") == nil {
		u.header = append(u.header, b...)
		if mp4Box(u.header, "moov") != nil {
			u.stop()
		}
	}
	return len(b), nil
}

// codecs reads, from header, the start of a stream up to its moov, the codec
// string MediaSource takes for each of its tracks (RFC 6381), from the track's
// sample entry: what the browser gets, so the strings always match the stream.
func codecs(header []byte) (_ string, err error) {
	// A box cut shorter than its fields panics, and is an error here.
	defer func() {
		if recover() != nil {
			err = errors.New("the stream's header is cut short")
		}
	}()
	var codecs []string
	for _, trak := range mp4Boxes(mp4Box(header, "moov")) {
		if string(trak[4:8]) != "trak" {
			continue
		}
		stsd := trak[8:]
		for _, kind := range []string{"mdia", "minf", "stbl", "stsd"} {
			stsd = mp4Box(stsd, kind)
		}
		// The first sample entry, after stsd's version, flags and count. Its
		// boxes follow 78 bytes of fields in video, and 28 in audio.
		entry := mp4Boxes(stsd[8:])[0]
		var codec string
		switch kind := string(entry[4:8]); kind {
		case "avc1", "avc3":
			c := mp4Box(entry[86:], "avcC")
			codec = fmt.Sprintf("%s.%02x%02x%02x", kind, c[1], c[2], c[3])
		case "hvc1", "hev1":
			// ISO 14496-15, E.3: the profile space and profile, the
			// compatibility flags in reverse, the tier and level, then the
			// constraint flags up to the last that isn't 0.
			c := mp4Box(entry[86:], "hvcC")
			codec = fmt.Sprintf("%s.%s%d.%X.%c%d", kind, []string{"", "A", "B", "C"}[c[1]>>6], c[1]&31,
				bits.Reverse32(binary.BigEndian.Uint32(c[2:])), "LH"[c[1]>>5&1], c[12])
			for _, flags := range bytes.TrimRight(c[6:12], "\x00") {
				codec += fmt.Sprintf(".%X", flags)
			}
		case "av01":
			// AV1 in ISOBMFF, 5: the profile, level, tier and bit depth.
			c := mp4Box(entry[86:], "av1C")
			depth := 8
			if c[2]&0x40 != 0 { // high_bitdepth, then twelve_bit
				depth = 10 + 2*int(c[2]>>5&1)
			}
			codec = fmt.Sprintf("av01.%d.%02d%c.%02d", c[1]>>5, c[1]&31, "MH"[c[2]>>7], depth)
		case "vp09":
			// VP9 in ISOBMFF: the profile, level and bit depth, after vpcC's
			// version and flags.
			c := mp4Box(entry[86:], "vpcC")
			codec = fmt.Sprintf("vp09.%02d.%02d.%02d", c[4], c[5], c[6]>>4)
		case "mp4a":
			// The audio object type opens the AudioSpecificConfig, innermost of
			// esds's descriptors (ISO 14496-1). Each has a tag, a size in up to
			// 4 bytes, then fields: FFmpeg writes 3 in the ES descriptor, and
			// 13 in the decoder config.
			d := mp4Box(entry[36:], "esds")[4:] // after its version and flags
			for _, fields := range []int{3, 13, 0} {
				d = d[1:]
				for d[0]&0x80 != 0 {
					d = d[1:]
				}
				d = d[1+fields:]
			}
			codec = fmt.Sprintf("mp4a.40.%d", d[0]>>3)
		case "Opus", "fLaC":
			codec = kind // in that case, or WebKit refuses it (#11)
		default:
			return "", fmt.Errorf("the stream's %s track has no codec string here", kind)
		}
		codecs = append(codecs, codec)
	}
	return strings.Join(codecs, ", "), nil
}

// mp4Box finds the box of type kind in b, a run of MP4 boxes, and returns what
// it holds, or nil.
func mp4Box(b []byte, kind string) []byte {
	for _, box := range mp4Boxes(b) {
		if string(box[4:8]) == kind {
			return box[8:]
		}
	}
	return nil
}

// mp4Boxes cuts b, a run of MP4 boxes, into its boxes, up to one it can't size.
func mp4Boxes(b []byte) [][]byte {
	var boxes [][]byte
	for len(b) >= 8 {
		size := binary.BigEndian.Uint32(b)
		if size < 8 || int64(size) > int64(len(b)) {
			break
		}
		boxes = append(boxes, b[:size])
		b = b[size:]
	}
	return boxes
}

// fraction is the value of s, a fraction such as "24000/1001", or 0 when it
// has none, as "0/0" has.
func fraction(s string) float64 {
	var num, den float64
	if _, err := fmt.Sscanf(s, "%g/%g", &num, &den); err != nil || den == 0 {
		return 0
	}
	return num / den
}

// runFFmpeg runs cmd, FFmpeg or ffprobe, with what it said on stderr in its
// error, from a line of its own: a failed Save shows the error's last line.
func runFFmpeg(cmd *exec.Cmd) error {
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s: %w:\n%s", cmd.Args[0], err, strings.TrimSpace(stderr.String()))
	}
	return nil
}
