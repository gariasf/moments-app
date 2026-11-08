// The Trimmer's marks (#17): the owner marks a Moment's start and end on a
// Source as it plays, and nudges them. Pure, with no DOM and no timers, so
// node --test runs it as the Trimmer does.

/**
 * Where a Moment can start and end, in seconds of the Source's own time, as
 * the server lists them around a time (media.go): its keyframes, and its clean
 * ends, the frames a copy can end on. In any order.
 */
export type Frames = { keyframes: number[]; cleanEnds: number[] };

export type Marks = {
	/** The Moment's first frame, a keyframe, in seconds of the Source's own time. */
	start: number | undefined;
	/** Its last frame, a clean end. */
	end: number | undefined;
	/** The edge selected. */
	edge: "start" | "end";
	/** Whether the marked stretch loops, which it can only with both edges marked. */
	loop: boolean;
	/** How far back the start is from where I was pressed, or "". */
	note: string;
};

export const noMarks: Marks = {
	start: undefined,
	end: undefined,
	edge: "start",
	loop: false,
	note: "",
};

// How far back from the playhead, in seconds, O marks a start when none is
// marked: the owner often knows a Moment only once it's over.
const START_BACK = 30;

/**
 * A stretch of the Source, from and to in seconds of its own time, whose
 * frames the server lists from the keyframe at or before from (media.go).
 */
export type Span = [from: number, to: number];

/**
 * The spans press needs the server's frames over, for key pressed with the
 * playhead at playhead: the playhead for I, and for O the time START_BACK s
 * before it too, where a start may go.
 */
export function around(key: string, playhead: number): Span[] {
	const back = playhead - START_BACK;
	if (key === "i") return [[playhead, playhead]];
	if (key === "o")
		return [
			[playhead, playhead],
			[back, back],
		];
	return [];
}

/**
 * Gives the marks after key, as KeyboardEvent names it in lower case, is
 * pressed with the playhead at playhead, in seconds of the Source's own time,
 * given frames over the spans around lists. I marks the start on the
 * keyframe at or before the playhead. O marks the end on the clean end at or
 * before it, and with no start, or one after that end, the start on the
 * keyframe at or before START_BACK s earlier. A start goes on the Source's
 * first keyframe when there's none before. Once O has marked both, the marked
 * stretch loops, and \ turns the loop off and on. Esc clears both, and Tab
 * switches the edge selected, once one is marked.
 */
export function press(
	marks: Marks,
	key: string,
	playhead: number,
	frames: Frames,
): Marks {
	switch (key) {
		case "i": {
			const start = startAt(frames, playhead);
			const back = playhead - start;
			// After the end, the start leaves no Moment, so the end goes.
			const end =
				marks.end !== undefined && marks.end >= start ? marks.end : undefined;
			return {
				start,
				end,
				edge: "start",
				loop: marks.loop && end !== undefined,
				// Once it's a tenth of a second or more: not on the frame I was
				// pressed on, nor on a first keyframe after it.
				note: back >= 0.05 ? `${back.toFixed(1)} s before you pressed I` : "",
			};
		}
		case "o": {
			const end = atOrBefore(frames.cleanEnds, playhead);
			if (end === undefined) return marks; // before the Source's first frame
			if (marks.start === undefined || marks.start > end)
				return {
					start: startAt(frames, playhead - START_BACK),
					end,
					edge: "end",
					loop: true,
					note: "",
				};
			return { ...marks, end, edge: "end", loop: true };
		}
		case "\\":
			if (marks.start === undefined || marks.end === undefined) return marks;
			return { ...marks, loop: !marks.loop };
		case "escape":
			return noMarks;
		case "tab":
			if (marks.start === undefined) return marks;
			return { ...marks, edge: marks.edge === "start" ? "end" : "start" };
	}
	return marks;
}

/**
 * A nudge moves edge, or else the edge selected, back, by -1, or on, by 1,
 * and with far, further.
 */
export type Nudge = { edge?: Marks["edge"]; by: -1 | 1; far?: boolean };

/** About how far, in seconds, a far nudge moves each edge, as #17's keys do. */
export const FAR = { start: 10, end: 1 };

// How far on, in seconds, a nudge looks for where each edge goes: past FAR,
// and past the next keyframe, up to 11 s on in Home's Sources (#14), or the
// next clean end.
// ponytail: before a gap between keyframes longer than AHEAD.start, → stays
// put, as on the Source's last; widen it if a Source has one.
const AHEAD = { start: 12, end: 2 };

/**
 * The span nudge needs the server's frames over: back, from just before the
 * edge, or FAR before it; on, to AHEAD past it. Without the edge marked, it
 * needs none, and moves nothing.
 */
export function span(marks: Marks, n: Nudge): Span | undefined {
	const edge = n.edge ?? marks.edge;
	const at = marks[edge];
	if (at === undefined) return undefined;
	if (n.by < 0) return [n.far ? at - FAR[edge] : at - 0.001, at];
	return [at, at + AHEAD[edge]];
}

/**
 * What the preview does as an edge moves: it holds on the frame at hold, the
 * edge's, then plays from play, in seconds of the Source's own time.
 */
export type Preview = { hold: number; play: number };

// How long before the end, in seconds, the preview plays from once the end
// has moved: enough to see the end come, and the loop go back to the start.
const LEAD = 2;

/**
 * Gives the marks after nudge, given the frames over its span, and what the
 * preview does: the start moves one keyframe and the end one clean end, and
 * each stops at the Source's first and last, and short of the other edge. Far,
 * the start goes on the keyframe at or before FAR.start s away, and the end on
 * the clean end at or before FAR.end s away, one keyframe or clean end at
 * least. The edge moved is selected, and the loop stays as it was. The preview
 * holds on the edge's frame, then plays from the start, or from LEAD s before
 * the end.
 */
export function nudge(
	marks: Marks,
	{ edge = marks.edge, by, far }: Nudge,
	frames: Frames,
): { marks: Marks; preview?: Preview } {
	const at = marks[edge];
	if (at === undefined) return { marks };
	const { start = -Infinity, end = Infinity } = marks;
	const times = (edge === "start" ? frames.keyframes : frames.cleanEnds)
		.filter((t) => (by < 0 ? t < at : t > at))
		// Each edge stays on its side of the other, so there's a Moment.
		.filter((t) => (edge === "start" ? t < end : t > start))
		.sort((a, b) => a - b);
	if (!times.length) return { marks };
	// With none at or before FAR away, on goes to the next, and back as far as
	// it can.
	const to = far
		? (atOrBefore(times, at + by * FAR[edge]) ?? times[0])
		: by < 0
			? times[times.length - 1]
			: times[0];
	// The note says where the start is from where I was pressed.
	const note = edge === "start" ? "" : marks.note;
	return {
		marks: { ...marks, [edge]: to, edge, note },
		preview: {
			hold: to,
			play: edge === "start" ? to : Math.max(start, to - LEAD),
		},
	};
}

/**
 * Gives the marks after the owner seeks to playhead, in seconds of the
 * Source's own time: away from the marks, the loop stops and the marks stay.
 * By the middle of its frame, the playhead on the end's frame is past the end,
 * so that's away too: the loop would go back to the start from it at once.
 */
export function seek(marks: Marks, playhead: number): Marks {
	const { start, end } = marks;
	const away =
		start === undefined ||
		end === undefined ||
		playhead < start ||
		playhead > end;
	return marks.loop && away ? { ...marks, loop: false } : marks;
}

/**
 * The title a Moment of the Source named name, from start in seconds of its
 * own time, is saved under unless the owner types another: the name and the
 * start, as "Severance S02E07 · 12:34". The server gives an empty title the
 * same (library.go).
 */
export function prefill(name: string, start: number): string {
	const s = Math.floor(Math.max(start, 0));
	const [h, m, ss] = [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60];
	const two = (n: number) => String(n).padStart(2, "0");
	return `${name} · ${h ? `${h}:${two(m)}` : m}:${two(ss)}`;
}

// startAt finds the keyframe at or before time, or else the Source's first.
function startAt({ keyframes }: Frames, time: number) {
	return atOrBefore(keyframes, time) ?? Math.min(...keyframes);
}

// atOrBefore finds the latest of times at or before time, if any.
function atOrBefore(times: number[], time: number) {
	const before = times.filter((t) => t <= time);
	return before.length ? Math.max(...before) : undefined;
}
