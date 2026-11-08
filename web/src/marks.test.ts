import assert from "node:assert/strict";
import { test } from "node:test";
import {
	around,
	type Frames,
	type Marks,
	type Nudge,
	noMarks,
	nudge,
	prefill,
	press,
	type Span,
	seek,
	span,
} from "./marks.ts";

// A movie's frames: keyframes 10.4 s apart, x264's and x265's longest gap, and
// clean ends 1 to 11 frames apart at 24 fps.
const keyframes = [0, 10.427, 20.854, 31.281, 41.708];
const movie: Frames = {
	keyframes,
	cleanEnds: [
		20.854, 20.896, 20.979, 21.104, 21.271, 21.479, 21.729, 22.021, 22.354,
		22.729, 23.146, 23.604,
	],
};
// The same movie without B-frames, where every frame is a clean end.
const frame = (n: number) => n / 24;
const everyFrame: Frames = {
	keyframes,
	cleanEnds: Array.from({ length: 60 * 24 }, (_, n) => frame(n)),
};
// A video whose time starts 10 s in, as some remuxes do, with keyframes 2 s
// apart, as in web downloads.
const late: Frames = {
	keyframes: Array.from({ length: 10 }, (_, n) => 10 + 2 * n),
	cleanEnds: Array.from({ length: 20 * 24 }, (_, n) => 10 + frame(n)),
};

// marked gives the marks after keys, each pressed with the playhead at a time.
function marked(frames: Frames, ...keys: [key: string, playhead: number][]) {
	return keys.reduce<Marks>(
		(marks, [key, playhead]) => press(marks, key, playhead, frames),
		noMarks,
	);
}

// listed gives the frames the server lists over a span of a Source with
// frames: from the keyframe at or before its start, or else the first,
// through its end (media.go).
function listed({ keyframes, cleanEnds }: Frames, [at, to]: Span): Frames {
	const from = keyframes.findLast((k) => k <= at) ?? keyframes[0];
	return {
		keyframes: keyframes.filter((k) => from <= k && k <= Math.max(from, to)),
		cleanEnds: cleanEnds.filter((t) => from <= t && t <= to),
	};
}

// nudgeOver nudges marks with the frames the server lists over the span the
// nudge needs, if any.
function nudgeOver(frames: Frames, marks: Marks, n: Nudge) {
	const over = span(marks, n);
	return nudge(marks, n, over ? listed(frames, over) : noFrames);
}

// nudged gives marks after nudges.
function nudged(frames: Frames, marks: Marks, ...nudges: Nudge[]) {
	return nudges.reduce((m, n) => nudgeOver(frames, m, n).marks, marks);
}

const noFrames: Frames = { keyframes: [], cleanEnds: [] };
const back = { edge: "start", by: -1 } as const;
const on = { edge: "start", by: 1 } as const;
const endBack = { edge: "end", by: -1 } as const;
const endOn = { edge: "end", by: 1 } as const;
const farBack = { ...back, far: true };
const farOn = { ...on, far: true };
const farEndBack = { ...endBack, far: true };
const farEndOn = { ...endOn, far: true };

test("I marks the start on the keyframe at or before the playhead, and says how far back it is", () => {
	for (const { playhead, start, note } of [
		{ playhead: 25.3, start: 20.854, note: "4.4 s before you pressed I" },
		{ playhead: 31.2, start: 20.854, note: "10.3 s before you pressed I" },
		// On the keyframe, by the middle of its frame.
		{ playhead: 20.875, start: 20.854, note: "" },
	])
		assert.deepEqual(
			marked(movie, ["i", playhead]),
			{ start, end: undefined, edge: "start", loop: false, note },
			`I at ${playhead} s`,
		);
});

test("O marks the end on the latest clean end at or before the playhead", () => {
	for (const { frames, playhead, end } of [
		{ frames: movie, playhead: 22.2, end: 22.021 },
		{ frames: movie, playhead: 22.375, end: 22.354 }, // on a clean end
		{ frames: movie, playhead: 23.9, end: 23.604 },
		{ frames: everyFrame, playhead: frame(530.5), end: frame(530) },
	])
		assert.deepEqual(
			marked(frames, ["i", 21.2], ["o", playhead]),
			{
				start: 20.854,
				end,
				edge: "end",
				loop: true,
				note: "0.3 s before you pressed I",
			},
			`O at ${playhead} s`,
		);
});

test("O with no start marks the start on the keyframe at or before 30 s earlier, never before the Source's start", () => {
	for (const { frames, playhead, start, end } of [
		{
			frames: everyFrame,
			playhead: frame(1082.5),
			start: 10.427,
			end: frame(1082),
		},
		{ frames: everyFrame, playhead: frame(732.5), start: 0, end: frame(732) },
		{ frames: everyFrame, playhead: frame(288.5), start: 0, end: frame(288) },
		{
			frames: late,
			playhead: 10 + frame(360.5),
			start: 10,
			end: 10 + frame(360),
		},
	])
		assert.deepEqual(
			marked(frames, ["o", playhead]),
			{ start, end, edge: "end", loop: true, note: "" },
			`O at ${playhead} s`,
		);
});

test("I or O again moves that edge, as the marks loop", () => {
	const marks = [
		["i", 25.3],
		["o", frame(800.5)],
	] satisfies [string, number][];
	assert.deepEqual(marked(everyFrame, ...marks, ["i", 31.5]), {
		start: 31.281,
		end: frame(800),
		edge: "start",
		loop: true,
		note: "0.2 s before you pressed I",
	});
	assert.deepEqual(marked(everyFrame, ...marks, ["o", frame(700.5)]), {
		start: 20.854,
		end: frame(700),
		edge: "end",
		loop: true,
		note: "4.4 s before you pressed I",
	});
	// A start after the end leaves no Moment, so the end goes, and the loop
	// with it; an end before the start puts the start 30 s back, as with none.
	assert.deepEqual(marked(everyFrame, ...marks, ["i", 43]), {
		start: 41.708,
		end: undefined,
		edge: "start",
		loop: false,
		note: "1.3 s before you pressed I",
	});
	assert.deepEqual(marked(everyFrame, ["i", 42], ["o", frame(960.5)]), {
		start: 0,
		end: 40,
		edge: "end",
		loop: true,
		note: "",
	});
});

test("Once both edges are marked, the marked stretch loops", () => {
	assert.equal(marked(everyFrame, ["i", 25.3]).loop, false);
	assert.equal(marked(everyFrame, ["i", 25.3], ["o", frame(800.5)]).loop, true);
	assert.equal(marked(everyFrame, ["o", frame(800.5)]).loop, true);
});

test("\\ turns the loop off and on, with both edges marked", () => {
	const both = [
		["i", 25.3],
		["o", frame(800.5)],
	] satisfies [string, number][];
	assert.deepEqual(marked(everyFrame, ...both, ["\\", 30]), {
		...marked(everyFrame, ...both),
		loop: false,
	});
	assert.deepEqual(
		marked(everyFrame, ...both, ["\\", 30], ["\\", 31]),
		marked(everyFrame, ...both),
	);
	// With an edge unmarked, there's nothing to loop.
	assert.deepEqual(
		marked(everyFrame, ["i", 25.3], ["\\", 26]),
		marked(everyFrame, ["i", 25.3]),
	);
	assert.deepEqual(marked(everyFrame, ["\\", 26]), noMarks);
});

test("A seek away from the marks stops the loop and keeps the marks", () => {
	const looping = marked(everyFrame, ["i", 25.3], ["o", frame(800.5)]);
	// The playhead is a frame's middle, so on the end's frame it's past the
	// end: the loop goes back to the start from there, so that's away too.
	for (const playhead of [20.8, frame(800.5), 50])
		assert.deepEqual(
			seek(looping, playhead),
			{ ...looping, loop: false },
			`to ${playhead} s`,
		);
	// From the start's frame to the one before the end's, it loops on.
	for (const playhead of [20.875, 25, frame(799.5)])
		assert.deepEqual(seek(looping, playhead), looping, `to ${playhead} s`);
});

test("Before the Source's first frame, I marks the start on it and O does nothing", () => {
	// As the server lists them around a time before the first frame.
	const beforeFirst: Frames = { keyframes: [10], cleanEnds: [] };
	assert.deepEqual(marked(beforeFirst, ["i", 5]), {
		start: 10,
		end: undefined,
		edge: "start",
		loop: false,
		note: "",
	});
	assert.deepEqual(marked(beforeFirst, ["o", 5]), noMarks);
});

test("O needs the frames 30 s back too, where a start may go", () => {
	assert.deepEqual(around("i", 45), [[45, 45]]);
	assert.deepEqual(around("o", 45), [
		[45, 45],
		[15, 15],
	]);
	assert.deepEqual(around("escape", 45), []);
});

test("Tab switches the edge the arrows move, once an edge is marked", () => {
	const both = marked(everyFrame, ["i", 25.3], ["o", frame(800.5)]);
	assert.deepEqual(press(both, "tab", 30, everyFrame), {
		...both,
		edge: "start",
	});
	assert.deepEqual(
		marked(
			everyFrame,
			["i", 25.3],
			["o", frame(800.5)],
			["tab", 30],
			["tab", 31],
		),
		both,
	);
	assert.equal(marked(everyFrame, ["i", 25.3], ["tab", 26]).edge, "end");
	// With no edge to move, Tab is the page's, which moves the focus.
	assert.equal(press(noMarks, "tab", 26, everyFrame), noMarks);
});

test("← and → move the start one keyframe, and stop at the Source's first and last", () => {
	const marks = marked(everyFrame, ["i", 25.3], ["o", frame(1300.5)]);
	assert.deepEqual(nudged(everyFrame, marks, on), {
		...marks,
		start: 31.281,
		edge: "start",
		note: "", // the start is no longer where I put it
	});
	for (const { nudges, start } of [
		{ nudges: [on, on], start: 41.708 },
		{ nudges: [on, on, on], start: 41.708 },
		{ nudges: [back], start: 10.427 },
		{ nudges: [back, back], start: 0 },
		{ nudges: [back, back, back], start: 0 },
	])
		assert.equal(
			nudged(everyFrame, marks, ...nudges).start,
			start,
			nudges.map((n) => (n.by < 0 ? "←" : "→")).join(""),
		);
	// On a Source whose time starts 10 s in, keyframes 2 s apart.
	const lateMarks = marked(late, ["i", 13], ["o", 29.9]);
	assert.equal(nudged(late, lateMarks, back, back).start, 10);
	assert.equal(nudged(late, lateMarks, on).start, 14);
});

test("← and → move the end one clean end, and stop at the Source's last frame", () => {
	const marks = marked(movie, ["i", 21.2], ["o", 22.2]);
	assert.deepEqual(nudged(movie, marks, endOn), { ...marks, end: 22.354 });
	for (const { nudges, end } of [
		{ nudges: [endOn, endOn], end: 22.729 },
		{ nudges: [endOn, endOn, endOn, endOn], end: 23.604 },
		{ nudges: [endOn, endOn, endOn, endOn, endOn], end: 23.604 },
		{ nudges: [endBack], end: 21.729 },
		{ nudges: [endBack, endBack], end: 21.479 },
	])
		assert.equal(
			nudged(movie, marks, ...nudges).end,
			end,
			nudges.map((n) => (n.by < 0 ? "←" : "→")).join(""),
		);
	// Where every frame is a clean end, a frame.
	const everyMarks = marked(everyFrame, ["i", 25.3], ["o", frame(800.5)]);
	assert.equal(nudged(everyFrame, everyMarks, endBack).end, frame(799));
	assert.equal(nudged(everyFrame, everyMarks, endOn).end, frame(801));
});

test("⇧← and ⇧→ move the start to the keyframe at or before 10 s away, by one keyframe at least", () => {
	// Keyframes 10.4 s apart: one each time.
	const marks = marked(everyFrame, ["i", 25.3], ["o", frame(1300.5)]);
	assert.equal(nudged(everyFrame, marks, farOn).start, 31.281);
	assert.equal(nudged(everyFrame, marks, farBack).start, 10.427);
	// Keyframes 2 s apart, from 10 s: 10 s, and back no further than the first.
	const lateMarks = marked(late, ["i", 15], ["o", 29.9]);
	assert.equal(nudged(late, lateMarks, farOn).start, 24);
	assert.equal(nudged(late, lateMarks, farOn, farBack).start, 14);
	assert.equal(nudged(late, lateMarks, farBack).start, 10);
});

test("⇧← and ⇧→ move the end to the clean end at or before 1 s away, by one clean end at least", () => {
	const marks = marked(movie, ["i", 21.2], ["o", 22.2]);
	assert.equal(nudged(movie, marks, farEndOn).end, 22.729);
	assert.equal(nudged(movie, marks, farEndOn, farEndOn).end, 23.604);
	assert.equal(nudged(movie, marks, farEndOn, farEndBack).end, 21.729);
	assert.equal(nudged(movie, marks, farEndBack).end, 20.979);
	// Clean ends 1.5 s apart, as in a slideshow.
	const slow: Frames = { keyframes: [0], cleanEnds: [0, 1.5, 3, 4.5] };
	const slowMarks = marked(slow, ["i", 0.2], ["o", 1.6]);
	assert.equal(nudged(slow, slowMarks, farEndOn).end, 3);
	assert.equal(nudged(slow, slowMarks, farEndOn, farEndBack).end, 1.5);
});

test("A nudge never takes an edge onto or past the other", () => {
	const marks = marked(everyFrame, ["i", 25.3], ["o", frame(800.5)]);
	assert.equal(nudged(everyFrame, marks, on, on).start, 31.281);
	const short = marked(everyFrame, ["i", 21], ["o", frame(600.5)]);
	assert.equal(nudged(everyFrame, short, farOn).start, 20.854);
	const ends = marked(movie, ["i", 21.2], ["o", 21]);
	assert.equal(nudged(movie, ends, endBack, endBack).end, 20.896);
	const later = marked(movie, ["i", 21.2], ["o", 21.3]);
	assert.equal(nudged(movie, later, farEndBack).end, 20.896);
});

test("Without an edge, a nudge moves the edge selected, once it's marked", () => {
	const both = marked(everyFrame, ["i", 25.3], ["o", frame(1300.5)]);
	assert.equal(nudged(everyFrame, both, { by: -1 }).end, frame(1299));
	const start = press(both, "tab", 30, everyFrame);
	assert.equal(nudged(everyFrame, start, { by: 1 }).start, 31.281);
	// With the end selected and unmarked, there's nothing to nudge, nor frames
	// to ask for: the arrows step the playhead (Trimmer.tsx).
	const end = marked(everyFrame, ["i", 25.3], ["tab", 26]);
	assert.equal(span(end, { by: 1 }), undefined);
	assert.deepEqual(nudge(end, { by: 1 }, everyFrame), { marks: end });
});

test("A nudge asks the preview to hold on the moved edge, then to play from the start, or from 2 s before the end", () => {
	const both = marked(everyFrame, ["i", 25.3], ["o", frame(1300.5)]);
	assert.deepEqual(nudgeOver(everyFrame, both, on), {
		marks: { ...both, start: 31.281, edge: "start", note: "" },
		preview: { hold: 31.281, play: 31.281 },
	});
	assert.deepEqual(nudgeOver(everyFrame, both, endBack).preview, {
		hold: frame(1299),
		play: frame(1299) - 2,
	});
	// The loop stays as \ left it.
	const unlooped = press(both, "\\", 30, everyFrame);
	assert.equal(nudgeOver(everyFrame, unlooped, endBack).marks.loop, false);
	// A Moment under 2 s long plays from its start.
	const short = marked(movie, ["i", 21.2], ["o", 22.2]);
	assert.deepEqual(nudgeOver(movie, short, endOn).preview, {
		hold: 22.354,
		play: 20.854,
	});
	// With the end unmarked, there's no loop.
	const started = marked(everyFrame, ["i", 25.3]);
	assert.deepEqual(nudgeOver(everyFrame, started, on), {
		marks: { ...started, start: 31.281, note: "" },
		preview: { hold: 31.281, play: 31.281 },
	});
	// A nudge with nowhere to go asks nothing.
	const first = marked(everyFrame, ["i", 5], ["o", 9]);
	assert.deepEqual(nudgeOver(everyFrame, first, back), { marks: first });
});

test("Esc clears both marks", () => {
	assert.deepEqual(
		marked(everyFrame, ["i", 25.3], ["o", frame(800.5)], ["escape", 34]),
		noMarks,
	);
	assert.deepEqual(marked(everyFrame, ["i", 25.3], ["escape", 26]), noMarks);
});

test("The title to prefill is the Source's name and the start, to the second it's in", () => {
	assert.equal(prefill("Severance S02E07", 754.97), "Severance S02E07 · 12:34");
	assert.equal(
		prefill("Tears of Steel (2012)", 9.96),
		"Tears of Steel (2012) · 0:09",
	);
	assert.equal(
		prefill("Quantum Of Solace (2008)", 3723.5),
		"Quantum Of Solace (2008) · 1:02:03",
	);
});
