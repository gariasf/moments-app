// The Trimmer check (#23, #24, #25, #30): through a host run (umbrel/host-run.sh), the Trimmer's
// player plays every Source in the test set from its start, in WebKit and in headless Chrome on the
// Mac, muted. Every frame shows at the Source's own packet time. Then, paused, each seek lands on
// the frame it aims at: inside the buffer with no new stream, outside it with one. Playing on at 2×
// from there runs at twice the speed, with no stall. Then a few seconds, marked as I and O would
// mark them, loop at 1×: over several passes no frame outside the marks shows, each pass begins on
// the start's frame, and how long the last frame holds before it is reported. On the Sources #23 and
// #24 timed, H.264 with AAC, the first frame shows within a second, and a seek's within about one.
// The rest are mostly 4K, whose times hang on how fast the SSH tunnel carries a stream, so theirs
// are only reported. A pass names the Sources by their traits and codec strings only, so it can go
// in a PR; a failure may print their paths, which stay out of the repo (#22).
// usage: node web/checks/trimmer.mjs <the URL umbrel/host-run.sh start prints>
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { runPage } from "./harness.mjs";

const SECONDS = 10; // of each Source, from its start
const FIRST_FRAME_MS = 1000; // after opening a timed Source (the stream's 1 s fragments)
const TOLERANCE_S = 2e-6; // ffprobe writes microseconds, and Chrome keeps them
const SEEK_MS = 1000; // from a seek outside a timed Source's buffer to its frame
const RATE = 2; // the Trimmer's fastest
const PLAY_S = 8; // of playing at RATE after the last seek, past what its stream holds by then
const LOOP_AT_S = 45; // where I marks the loop's start, from the Source's first frame: past the 2×
const LOOP_S = 3; // from the start to where O marks the end
const PASSES = 5; // of the loop, each back to its start
const SOURCE_S = 90; // for the page to play each Source, failing seeks included

const url = process.argv[2];
if (!url) {
	console.log(
		"usage: node web/checks/trimmer.mjs <the URL umbrel/host-run.sh start prints>",
	);
	process.exit(2);
}

// Runs command on the Umbrel with input on its stdin. Agents only read there, outside
// /home/umbrel/moments-check and /tmp (docs/agents/workflow.md, The Umbrel).
function onUmbrel(command, input = "") {
	return execFileSync(
		"ssh",
		[
			"-o",
			"BatchMode=yes",
			"-i",
			join(homedir(), ".ssh/umbrel_moments"),
			"umbrel@umbrel.local",
			command,
		],
		{ input, encoding: "utf8" },
	);
}

// This branch's host run, whose scratch folder holds the MeTube downloads it plays (host-run.sh).
const run = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
	encoding: "utf8",
}).trim();

// Every Source in the test set, by the traits it covers, with the codec strings the server gives
// it, the times of its video packets as ffprobe reads them on the Umbrel, and seeks around them.
// The server must say the Trimmer plays each one.
const sources = [];
const problems = [];
for (const line of onUmbrel(
	"cat /home/umbrel/moments-check/test-set.tsv",
).split("\n")) {
	const [path, traits] = line.split("\t");
	if (!traits || path.startsWith("#")) continue;
	const res = await fetch(
		new URL(`api/source?${new URLSearchParams({ path })}`, url),
	);
	const probe = res.ok ? await res.json() : {};
	if (!probe.codecs) {
		problems.push(
			`${traits}: the server won't play it: ${probe.cantPlay ?? res.status}`,
		);
		continue;
	}
	// From its start, and around the seeks outside the buffer: 60% in, then back to 30%. The ends
	// are times, since an offset (%+) counts from the keyframe ffprobe starts at.
	const [aheadAt, backAt] = [0.6, 0.3].map((share) => share * probe.duration);
	// The run's own copy of a MeTube download, else the Source in Home.
	const packets = onUmbrel(
		`IFS= read -r run; IFS= read -r path; case $path in Downloads/metube/*) path=/home/umbrel/moments-check/$run/metube/\${path#Downloads/metube/} ;; *) path=$HOME/umbrel/home/$path ;; esac; exec ffprobe -v error -select_streams V:0 -read_intervals %+${SECONDS + 15},${aheadAt}%${aheadAt + 12},${backAt}%${backAt + 12} -show_entries packet=pts_time,flags -of csv=p=0 "$path"`,
		`${run}\n${path}\n`,
	)
		.split("\n")
		.filter(Boolean)
		.map((packet) => packet.split(",")) // side data adds fields
		.map(([pts, flags]) => ({ time: Number(pts), key: flags.startsWith("K") }))
		.sort((a, b) => a.time - b.time);
	const times = packets.map(({ time }) => time);
	// The last frame before the first keyframe at least a second after time, and that keyframe.
	// A seek there decodes a whole GOP, and a stream for it lands late unless it starts early
	// enough (#11).
	const lastOfGop = (time) => {
		const i = packets.findIndex(
			(packet) => packet.key && packet.time >= time + 1,
		);
		return i > 0 && { frame: times[i - 1], next: times[i] };
	};
	const [played, ahead, back] = [times[0] + SECONDS / 2, aheadAt, backAt].map(
		lastOfGop,
	);
	if (!played || !ahead || !back) {
		problems.push(`${traits}: no frames to seek to`);
		continue;
	}
	// Each seek aims at its frame's time plus half a frame (#11).
	const aim = ({ frame, next }) => ({ seek: (frame + next) / 2, want: frame });
	const seeks = [
		{ name: "inside the buffer", ...aim(played) },
		{ name: "a frame on", step: 1, want: played.next },
		{ name: "a frame back", step: -1, want: played.frame },
		{ name: "to 60%", ...aim(ahead) },
		{ name: "back to 30%", ...aim(back) },
		{
			name: "twice at once",
			seek: [aim(ahead).seek, aim(played).seek],
			want: played.frame,
		},
	];
	const timed = /H\.264.*AAC/.test(traits);
	// The loop, as I and O mark it (marks.ts): from the keyframe at or before LOOP_AT_S s in to the
	// clean end at or before LOOP_S s after that, where a Save can cut (media.go).
	const framesAt = async (at) => {
		const res = await fetch(
			new URL(`api/source/frames?${new URLSearchParams({ path, at })}`, url),
		);
		if (!res.ok) throw new Error(`${res.status} ${(await res.text()).trim()}`);
		return res.json();
	};
	let loop;
	try {
		const start = Math.max(...(await framesAt(times[0] + LOOP_AT_S)).keyframes);
		const end = Math.max(...(await framesAt(start + LOOP_S)).cleanEnds);
		if (!(end > start)) throw new Error(`no clean end after ${start} s`);
		loop = { start, end };
	} catch (e) {
		problems.push(`${traits}: no loop to mark ${LOOP_AT_S} s in: ${e.message}`);
		continue;
	}
	sources.push({
		path,
		traits,
		codecs: probe.codecs,
		timed,
		times,
		seeks,
		loop,
	});
}
if (!sources.length) problems.push("the test set has no Source");

const engines = sources.length
	? await runPage(
			`trimmer.html?seconds=${SECONDS}&rate=${RATE}&play=${PLAY_S}&passes=${PASSES}&sources=${encodeURIComponent(JSON.stringify(sources.map(({ path, seeks, loop }) => ({ path, seeks: seeks.map(({ seek, step }) => ({ seek, step })), loop }))))}`,
			undefined,
			url,
			sources.length * SOURCE_S,
		)
	: {};
for (const [engine, { error, log }] of Object.entries(engines)) {
	if (error)
		problems.push(
			`${engine}: ${error}`,
			...log.slice(-10).map((line) => `  ${line}`),
		);
}
const atPacket = (times, time) =>
	times.some((packet) => Math.abs(packet - time) <= TOLERANCE_S);
// How long the last frame held on each pass, in each engine, in ms.
const holds = Object.fromEntries(Object.keys(engines).map((e) => [e, []]));
for (const { path, traits, codecs, timed, times, seeks, loop } of sources) {
	const cells = Object.entries(engines).map(([engine, { results = [] }]) => {
		const seen = results.find((result) => result.path === path);
		if (!seen) return `${engine} -`;
		if (seen.problem) {
			problems.push(`${engine}, ${traits}: ${seen.problem}`);
			return `${engine} can't play`;
		}
		const { frames, firstFrameMs } = seen;
		const exact = frames.filter((time) => atPacket(times, time)).length;
		const ms = Math.round(firstFrameMs ?? Number.NaN);
		const fromStart = Math.abs(frames[0] - times[0]) <= TOLERANCE_S;
		const ok =
			frames.length &&
			exact === frames.length &&
			fromStart &&
			!(timed && ms > FIRST_FRAME_MS);
		if (!ok)
			problems.push(
				`${engine}, ${traits}: ${exact} of ${frames.length} frames at a packet time, the first at ${frames[0]} s (the Source starts at ${times[0]} s), after ${ms} ms`,
			);
		const who = `${engine}, ${traits}`;
		const held = loopHolds(who, loop, seen.loop);
		holds[engine].push(...held);
		return `${engine} ${exact}/${frames.length} frames, ${ms} ms${ok ? "" : "!"}; ${seekCell(who, timed, seeks, seen)}; loop ${held.length} passes, held ${spread(held)} ms`;
	});
	console.log(`${traits}: ${codecs}\n  ${cells.join(" · ")}`);
}
console.log(
	`the loop's last frame held (min/median/max): ${Object.entries(holds)
		.map(
			([engine, held]) =>
				`${engine} ${spread(held)} ms over ${held.length} passes`,
		)
		.join(", ")}`,
);

// How long the last frame held before each pass of the loop from start to end, in ms, as who (an
// engine and a Source) showed frames, each [its time, when it showed]. A pass begins on the start,
// first and right after the end, and no frame outside them shows. What went wrong goes to problems.
function loopHolds(who, { start, end }, frames = []) {
	const near = (time, want) => Math.abs(time - want) <= TOLERANCE_S;
	const outside = frames.filter(
		([time]) => time < start - TOLERANCE_S || time > end + TOLERANCE_S,
	);
	if (outside.length)
		problems.push(
			`${who}: ${outside.length} frames outside ${start} to ${end} s showed, the first at ${outside[0][0]} s`,
		);
	const held = [];
	for (const [i, [time, when]] of frames.entries()) {
		const [last, shown] = frames[i - 1] ?? [];
		if (i && time >= last) continue; // playing on
		if (near(time, start) && (!i || near(last, end))) {
			if (i) held.push(when - shown);
		} else
			problems.push(
				`${who}: a pass began on the frame at ${time} s${i ? `, after ${last} s` : ""}; want ${start} s${i ? `, after ${end} s` : ""}`,
			);
	}
	if (held.length < PASSES)
		problems.push(
			`${who}: the loop went back ${held.length} times; want ${PASSES}`,
		);
	return held;
}

// spread writes the least, the median and the most of numbers, in whole numbers.
function spread(numbers) {
	const sorted = numbers.toSorted((a, b) => a - b);
	return [sorted[0], sorted[sorted.length >> 1], sorted.at(-1)]
		.map((n) => (n === undefined ? "-" : Math.round(n)))
		.join("/");
}
// What the seeks and 2× did, for who (an engine and a Source): how many landed on their frame
// with the streams they should start, in time if the Source is timed, how long those that streamed
// took, and the speed and stalls at 2×. What went wrong goes to problems.
function seekCell(
	who,
	timed,
	seeks,
	{ seeks: landed = [], speed = Number.NaN, stalls },
) {
	let on = 0;
	const streamedMs = [];
	for (const [i, { name, want }] of seeks.entries()) {
		const seen = landed[i] ?? {};
		// A stream exactly when the time sought was outside the buffer (#24). On a fast tunnel,
		// WebKit can hold more than the 30 s the player streams ahead, since its buffered lags.
		const streams = seen.outside ? 1 : 0;
		if (
			Math.abs(seen.frame - want) <= TOLERANCE_S &&
			seen.streams === streams &&
			!(timed && seen.ms > SEEK_MS)
		)
			on++;
		else
			problems.push(
				`${who}, ${name}: ${seen.frame === undefined ? "no frame showed" : `showed the frame at ${seen.frame} s after ${Math.round(seen.ms)} ms, with ${seen.streams} new streams`}; want ${want} s, with ${streams}`,
			);
		if (streams)
			streamedMs.push(seen.frame === undefined ? "-" : Math.round(seen.ms));
	}
	if (!(Math.abs(speed - RATE) <= RATE * 0.1))
		problems.push(`${who}: at ${RATE}× it played at ${speed.toFixed(2)}×`);
	if (stalls !== 0)
		problems.push(`${who}: at ${RATE}× it stalled ${stalls ?? "untold"} times`);
	return `seeks ${on}/${seeks.length}, ${streamedMs.join("/")} ms; ${speed.toFixed(2)}×, ${stalls} stalls`;
}

if (problems.length) {
	console.log(`FAIL\n${problems.join("\n")}`);
	process.exitCode = 1;
} else {
	console.log(
		`pass: every frame at the Source's own packet time, from its first; every seek on its frame, with a stream only\noutside the buffer; ${RATE}× within 10% with no stall; on H.264/AAC, the first frame within ${FIRST_FRAME_MS} ms, and seeks within ${SEEK_MS} ms;\nthe loop: ${PASSES} passes, each from the start's frame right after the end's, and no frame outside them`,
	);
}
