// Command iphone serves the iPhone check page on the LAN, with test Moments it makes in iphone/ beside itself, and the run's own Moments.
package main

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"mime"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
)

//go:embed index.html
var page []byte

// 30 fps, with the frame number in binary across the top 40 rows: 8 bars, white for a 1.
const videoInput = "-f lavfi -i testsrc2=size=1280x720:rate=30,split[base][strip];[strip]crop=1280:40:0:0,format=yuv420p,geq=lum='255*gt(bitand(N,pow(2,trunc(X/160))),0)':cb=128:cr=128[bar];[base][bar]overlay"
const audioInput = "-f lavfi -i sine=frequency=440:sample_rate=48000"

type moment struct {
	File            string `json:"file"`
	Label           string `json:"label"`
	Want            string `json:"want,omitempty"`
	ffmpegArguments string
}

var codecs = []moment{
	{"h264-high.mp4", "H.264 High", "plays", videoInput + " -c:v libx264 -profile:v high -pix_fmt yuv420p"},
	{"h264-high10.mp4", "H.264 High 10", "plays", videoInput + " -c:v libx264 -profile:v high10 -pix_fmt yuv420p10le"},
	{"hevc-main10.mp4", "HEVC Main10 hvc1", "plays", videoInput + " -c:v libx265 -profile:v main10 -pix_fmt yuv420p10le -tag:v hvc1 -x265-params log-level=error"},
	{"vp9-p0.mp4", "VP9 profile 0", "fails", videoInput + " -c:v libvpx-vp9 -profile:v 0 -pix_fmt yuv420p -deadline realtime -cpu-used 8"},
	{"vp9-p2.mp4", "VP9 profile 2 10-bit", "fails", videoInput + " -c:v libvpx-vp9 -profile:v 2 -pix_fmt yuv420p10le -deadline realtime -cpu-used 8"},
	{"av1.mp4", "AV1", "plays", videoInput + " -c:v libsvtav1 -preset 10 -pix_fmt yuv420p"},
	{"aac-2.0.m4a", "AAC stereo", "plays", audioInput + " -c:a aac -ch_layout stereo"},
	{"aac-5.1.m4a", "AAC 5.1", "plays", audioInput + " -c:a aac -ch_layout 5.1"},
	{"aac-7.1.m4a", "AAC 7.1", "plays", audioInput + " -c:a aac -ch_layout 7.1"},
	{"opus-2.0.m4a", "Opus stereo", "plays", audioInput + " -c:a libopus -ch_layout stereo"},
	{"opus-5.1.m4a", "Opus 5.1", "plays", audioInput + " -c:a libopus -ch_layout 5.1"},
	{"flac-2.0.m4a", "FLAC stereo", "plays", audioInput + " -c:a flac -ch_layout stereo"},
	{"flac-5.1.m4a", "FLAC 5.1", "plays", audioInput + " -c:a flac -ch_layout 5.1"},
	{"ac3-5.1.m4a", "AC-3 5.1", "plays", audioInput + " -c:a ac3 -ch_layout 5.1"},
	{"eac3-5.1.m4a", "E-AC-3 5.1", "plays", audioInput + " -c:a eac3 -ch_layout 5.1"},
}

var queue = []moment{
	{File: "queue-h264-2.0.mp4", Label: "H.264 stereo", ffmpegArguments: videoInput + " " + audioInput + " -c:v libx264 -c:a aac -ch_layout stereo"},
	{File: "queue-h264-5.1.mp4", Label: "H.264 5.1", ffmpegArguments: videoInput + " " + audioInput + " -c:v libx264 -c:a aac -ch_layout 5.1"},
	{File: "queue-hevc-2.0.mp4", Label: "HEVC stereo", ffmpegArguments: videoInput + " " + audioInput + " -c:v libx265 -tag:v hvc1 -x265-params log-level=error -c:a aac -ch_layout stereo"},
}

func main() {
	executable, error := os.Executable()
	if error != nil {
		log.Fatal(error)
	}
	folder := filepath.Join(filepath.Dir(executable), "iphone")
	media := filepath.Join(folder, "media")
	if error := os.MkdirAll(media, 0o755); error != nil {
		log.Fatal(error)
	}
	mime.AddExtensionType(".mp4", "video/mp4")
	mime.AddExtensionType(".m4a", "audio/mp4")
	for _, group := range []struct {
		tests   []moment
		seconds string
	}{{codecs, "2"}, {queue, "1"}} {
		for _, test := range group.tests {
			made := filepath.Join(media, test.File)
			if _, error := os.Stat(made); error == nil {
				continue
			}
			arguments := append([]string{"-nostdin", "-v", "error"}, strings.Fields(test.ffmpegArguments)...)
			ffmpeg := exec.Command("ffmpeg", append(arguments, "-t", group.seconds, "-f", "mp4", made+".part")...)
			if output, error := ffmpeg.CombinedOutput(); error != nil {
				log.Fatalf("making %s: %v\n%s", test.File, error, output)
			}
			if error := os.Rename(made+".part", made); error != nil {
				log.Fatal(error)
			}
		}
	}
	runMoments := filepath.Join(filepath.Dir(executable), "Moments")

	results, error := os.OpenFile(filepath.Join(folder, "results.txt"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if error != nil {
		log.Fatal(error)
	}
	var writing sync.Mutex
	routes := http.NewServeMux()
	routes.HandleFunc("GET /{$}", func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "text/html; charset=utf-8")
		writer.Write(page)
	})
	routes.HandleFunc("GET /manifest.json", func(writer http.ResponseWriter, request *http.Request) {
		tests := slices.Clone(codecs)
		momentFiles, _ := filepath.Glob(filepath.Join(runMoments, "*.mp4"))
		for _, file := range momentFiles {
			name := filepath.Base(file)
			tests = append(tests, moment{File: "moments/" + name, Label: name, Want: "plays"})
		}
		writer.Header().Set("Content-Type", "application/json")
		json.NewEncoder(writer).Encode(map[string][]moment{"codecs": tests, "queue": queue})
	})
	routes.Handle("GET /media/", http.StripPrefix("/media/", http.FileServer(http.Dir(media))))
	routes.Handle("GET /media/moments/", http.StripPrefix("/media/moments/", http.FileServer(http.Dir(runMoments))))
	routes.HandleFunc("POST /results", func(writer http.ResponseWriter, request *http.Request) {
		line, error := io.ReadAll(http.MaxBytesReader(writer, request.Body, 64<<10))
		if error != nil {
			http.Error(writer, error.Error(), http.StatusRequestEntityTooLarge)
			return
		}
		writing.Lock()
		defer writing.Unlock()
		fmt.Fprintf(results, "%s\n", strings.TrimRight(string(line), "\n"))
	})

	listener, error := net.Listen("tcp", ":0")
	if error != nil {
		log.Fatal(error)
	}
	port := fmt.Sprint(listener.Addr().(*net.TCPAddr).Port)
	if error := os.WriteFile(filepath.Join(folder, "port"), []byte(port), 0o644); error != nil {
		log.Fatal(error)
	}
	log.Fatal(http.Serve(listener, routes))
}
