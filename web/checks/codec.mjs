// The codec check (#19): clips that FFmpeg 7.1.5 makes decode in WebKit and in headless Chrome on the
// Mac as #13's table says. usage: node web/checks/codec.mjs
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPage } from "./harness.mjs";

// CI's image and FFmpeg (.github/workflows/ci.yml), on amd64 like CI and the Umbrel.
const IMAGE =
	"debian:trixie-slim@sha256:62bd423aeee912639ca8ee681c2b762cb3e25137e0a92b20be455898a9f034ad";
const FFMPEG_VERSION = "7:7.1.5-0+deb13u1";
const VIDEO = "-f lavfi -i testsrc2=size=1280x720:rate=24";
const AUDIO = "-f lavfi -i sine=frequency=440:sample_rate=48000";

// How FFmpeg makes each clip, what ffprobe must read back from it, and where and how #13 says
// it fails.
const CLIPS = [
	{
		file: "h264-high.mp4",
		make: `${VIDEO} -c:v libx264 -profile:v high -pix_fmt yuv420p`,
		probe: "h264,High,avc1,yuv420p",
	},
	{
		file: "h264-high10.mp4",
		make: `${VIDEO} -c:v libx264 -profile:v high10 -pix_fmt yuv420p10le`,
		probe: "h264,High 10,avc1,yuv420p10le",
	},
	{
		file: "hevc-main10.mp4",
		make: `${VIDEO} -c:v libx265 -profile:v main10 -pix_fmt yuv420p10le -tag:v hvc1 -x265-params log-level=error`,
		probe: "hevc,Main 10,hvc1,yuv420p10le",
	},
	{
		file: "av1.mp4",
		make: `${VIDEO} -c:v libsvtav1 -preset 10 -pix_fmt yuv420p`,
		probe: "av1,Main,av01,yuv420p",
	},
	{
		file: "aac-2.0.m4a",
		make: `${AUDIO} -c:a aac -ch_layout stereo`,
		probe: "aac,LC,mp4a,2",
	},
	{
		file: "aac-5.1.m4a",
		make: `${AUDIO} -c:a aac -ch_layout 5.1`,
		probe: "aac,LC,mp4a,6",
	},
	{
		file: "opus-2.0.m4a",
		make: `${AUDIO} -c:a libopus -ch_layout stereo`,
		probe: "opus,unknown,Opus,2",
	},
	{
		file: "flac-2.0.m4a",
		make: `${AUDIO} -c:a flac -ch_layout stereo`,
		probe: "flac,unknown,fLaC,2",
	},
	{
		file: "ac3-5.1.m4a",
		make: `${AUDIO} -c:a ac3 -ch_layout 5.1`,
		probe: "ac3,unknown,ac-3,6",
		fails: { chrome: "MediaError 4" },
	},
];

// The Mac has no FFmpeg, so the clips are made in Docker, once per version of this table, and
// checked against it on every run.
function makeClips() {
	const script = [
		`apt-get update -qq && apt-get install -qq -y --no-install-recommends ffmpeg=${FFMPEG_VERSION} >/dev/null`,
		...CLIPS.map(
			({ file, make }) =>
				`ffmpeg -nostdin -v error ${make} -t 2 -f mp4 ${file}`,
		),
		...CLIPS.map(
			({ file }) =>
				`echo "${file},$(ffprobe -v error -show_entries stream=codec_name,profile,codec_tag_string,pix_fmt,channels -of csv=p=0 ${file})"`,
		),
	].join("\n");
	const dir = join(
		tmpdir(),
		`moments-codec-${createHash("sha256")
			.update(IMAGE + script)
			.digest("hex")
			.slice(0, 12)}`,
	);
	if (!existsSync(dir)) {
		console.log("Making the clips with FFmpeg 7.1.5 in Docker");
		const work = mkdtempSync(`${dir}-`);
		const made = spawnSync(
			"docker",
			[
				"run",
				"--rm",
				"--platform",
				"linux/amd64",
				"-e",
				"DEBIAN_FRONTEND=noninteractive",
				"-v",
				`${work}:/out`,
				"-w",
				"/out",
				IMAGE,
				"sh",
				"-ec",
				script,
			],
			{ encoding: "utf8" },
		);
		if (made.status !== 0) {
			rmSync(work, { recursive: true, force: true });
			console.log(`FFmpeg in Docker exited with ${made.status ?? made.error}`);
			console.log(made.stderr?.trimEnd().split("\n").slice(-15).join("\n"));
			process.exit(1);
		}
		writeFileSync(join(work, "probe.csv"), made.stdout);
		renameSync(work, dir);
	}
	// Side data, such as AC-3's, adds empty fields at the end of a line.
	const probed = Object.fromEntries(
		readFileSync(join(dir, "probe.csv"), "utf8")
			.split("\n")
			.map((line) => line.replace(/,+$/, "").split(/,(.*)/, 2)),
	);
	const wrong = CLIPS.filter(({ file, probe }) => probed[file] !== probe);
	for (const { file, probe } of wrong)
		console.log(`${file}: ffprobe reads "${probed[file]}", want "${probe}"`);
	if (wrong.length) process.exit(1);
	return dir;
}

const media = makeClips();
const engines = await runPage(
	`codec.html?clips=${CLIPS.map(({ file }) => file).join(",")}`,
	media,
);
const problems = [];
const notes = [];
for (const [engine, { error, log }] of Object.entries(engines)) {
	if (error)
		problems.push(
			`${engine}: ${error}`,
			...log.slice(-10).map((line) => `  ${line}`),
		);
}
const names = Object.keys(engines);
const row = (cells) =>
	cells
		.map((cell) => cell.padEnd(16))
		.join(" ")
		.trimEnd();
console.log(row(["clip", ...names]));
for (const clip of CLIPS) {
	const cells = names.map((engine) => {
		const { error, results = [] } = engines[engine];
		const seen = results.find(({ file }) => file === clip.file);
		if (!seen) {
			if (!error) problems.push(`${engine} ${clip.file}: no result`);
			return "-";
		}
		const failure = clip.fails?.[engine];
		const asSaid = failure
			? seen.verdict === "fails" && seen.detail.startsWith(failure)
			: seen.verdict === "plays";
		const want = failure ? `fails with ${failure}` : "plays";
		if (!asSaid)
			problems.push(
				`${engine} ${clip.file}: ${seen.verdict}, want ${want}: ${seen.detail}`,
			);
		else if (failure)
			notes.push(`${engine} ${clip.file} fails as #13 says: ${seen.detail}`);
		return asSaid ? seen.verdict : `${seen.verdict}!`;
	});
	console.log(row([clip.file, ...cells]));
}
if (notes.length) console.log(notes.join("\n"));
if (problems.length) {
	console.log(`FAIL\n${problems.join("\n")}`);
	process.exitCode = 1;
} else {
	console.log("pass: every clip as #13's table says");
}
