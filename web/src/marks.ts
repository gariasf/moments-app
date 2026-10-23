// The Trimmer's marks (#17): the owner marks a Moment's start and end on a
// Source as it plays. Pure, with no DOM and no timers, so node --test runs it
// as the Trimmer does.

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
 * The times press needs the server's frames around, for key pressed with the
 * playhead at playhead: the playhead for I, and for O the time START_BACK s
 * before it too, where a start may go.
 */
export function around(key: string, playhead: number): number[] {
	if (key === "i") return [playhead];
	if (key === "o") return [playhead, playhead - START_BACK];
	return [];
}

/**
 * Gives the marks after key, as KeyboardEvent names it in lower case, is
 * pressed with the playhead at playhead, in seconds of the Source's own time,
 * given frames around the times around lists. I marks the start on the
 * keyframe at or before the playhead. O marks the end on the clean end at or
 * before it, and with no start, or one after that end, the start on the
 * keyframe at or before START_BACK s earlier. A start goes on the Source's
 * first keyframe when there's none before. Once O has marked both, the marked
 * stretch loops, and \ turns the loop off and on. Esc clears both.
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
	}
	return marks;
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

// startAt finds the keyframe at or before time, or else the Source's first.
function startAt({ keyframes }: Frames, time: number) {
	return atOrBefore(keyframes, time) ?? Math.min(...keyframes);
}

// atOrBefore finds the latest of times at or before time, if any.
function atOrBefore(times: number[], time: number) {
	const before = times.filter((t) => t <= time);
	return before.length ? Math.max(...before) : undefined;
}
