import assert from "node:assert/strict";
import { test } from "node:test";
import {
	around,
	type Frames,
	type Marks,
	noMarks,
	press,
	seek,
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
	assert.deepEqual(around("i", 45), [45]);
	assert.deepEqual(around("o", 45), [45, 15]);
	assert.deepEqual(around("escape", 45), []);
});

test("Esc clears both marks", () => {
	assert.deepEqual(
		marked(everyFrame, ["i", 25.3], ["o", frame(800.5)], ["escape", 34]),
		noMarks,
	);
	assert.deepEqual(marked(everyFrame, ["i", 25.3], ["escape", 26]), noMarks);
});
