// The Trimmer's player (#11, ADR-0003): a Source plays through MediaSource,
// fed by the server's live stream of it from wherever it's sought. It's
// framework-free, so the browser checks run it as the Trimmer does.

// What GET /api/source answers (media.go).
export type Probe = {
	duration: number;
	codecs?: string;
	frameRate?: number;
	cantPlay?: string;
	audioTracks?: AudioTrack[];
};

/** One of a Source's audio tracks, as its probe lists them (media.go). */
export type AudioTrack = {
	language?: string; // as the Source tags it, such as eng
	codec: string; // as players name it, such as E-AC-3
	channels: number;
	default?: boolean; // the one a stream carries unless asked for another
};

// How far, in seconds, the stream runs ahead of the playhead. Past it, the
// stream waits, and so does its FFmpeg on the Umbrel.
const AHEAD_S = 30;

/** A Source playing in the Trimmer. */
export type Playback = {
	/**
	 * Shows the frame at time, in seconds of the Source's own time: at once
	 * when it's buffered, else from a new stream.
	 */
	seek(time: number): void;
	/**
	 * The time of the frame on screen, by its middle, or of the frame a seek is
	 * on its way to, in seconds of the Source's own time.
	 */
	playhead(): number;
	/** Seeks seconds on from the frame on screen, or back when < 0. */
	jump(seconds: number): void;
	/** Shows the frame frames after the one on screen, or before when < 0. */
	step(frames: number): void;
	/**
	 * Plays the frames from start to end, in seconds of the Source's own time,
	 * over and over: from start when the loop turns on, or when the frame on
	 * screen is outside them, and back to it once end's frame shows. Without
	 * them, it plays on.
	 */
	loop(start?: number, end?: number): void;
	/**
	 * Plays the audio track track, counted from 0 in the probe's list, from the
	 * frame on screen, in a new stream.
	 */
	switchAudio(track: number): void;
	stop(): void;
};

/**
 * Plays the Source at path, a path in Home, in video from its start. When it
 * can't, it stops and says why to onProblem, in a sentence for the owner. Each
 * frame's own time goes to onFrame as the frame shows, and the Source's probe
 * to onOpen once it opens.
 */
export function playSource(
	video: HTMLVideoElement,
	path: string,
	onProblem: (message: string) => void,
	onFrame?: (time: number) => void,
	onOpen?: (probe: Probe) => void,
): Playback {
	const stop = new AbortController();
	const fail = (message: string) => {
		if (stop.signal.aborted) return;
		stop.abort();
		onProblem(message);
	};
	const mediaSource = new MediaSource();
	video.src = URL.createObjectURL(mediaSource);
	// Asked for at once, while the owner's click still counts, so Safari lets it
	// play with sound. Otherwise it waits for Space.
	video.play().catch(() => {});
	video.addEventListener(
		"error",
		() =>
			fail(
				`The browser can't play this Source: MediaError ${video.error?.code} ${video.error?.message ?? ""}`.trim(),
			),
		{ signal: stop.signal },
	);

	let frameLength = 0; // in seconds, from the frame rate
	// Where in the Source the frame on screen is, by its middle, or where a
	// seek is on its way to. Jumps and steps go from it, so they land as far
	// into a frame as it is: at its own time, Chrome can show the frame before
	// (#11).
	let aim = 0;
	// The frame clock is mediaTime, the frame's own time, never a count of
	// callbacks, which WebKit sometimes skips (#11).
	video.requestVideoFrameCallback(function frame(_, { mediaTime }) {
		if (stop.signal.aborted) return;
		if (!video.seeking && !replacing) {
			aim = mediaTime + frameLength / 2;
			loopBack();
		}
		onFrame?.(mediaTime);
		video.requestVideoFrameCallback(frame);
	});

	// What the buffer takes, with its codecs, as each stream's Content-Type
	// gives them: a stream of another audio track can carry another codec.
	let type = "";
	const opened = (async () => {
		const [probe] = await Promise.all([
			getJSON<Probe>(
				`/api/source?${new URLSearchParams({ path })}`,
				stop.signal,
			),
			once(mediaSource, "sourceopen", stop.signal),
		]);
		if (probe.cantPlay)
			throw new Error(`The Trimmer can't play this Source: ${probe.cantPlay}.`);
		type = `video/mp4; codecs="${probe.codecs}"`;
		const buffer = mediaSource.addSourceBuffer(type);
		mediaSource.duration = probe.duration; // once, before any seek (#11)
		frameLength = probe.frameRate ? 1 / probe.frameRate : 0;
		aim = frameLength / 2;
		onOpen?.(probe);
		return buffer;
	})();
	opened.catch((err: Error) => fail(err.message));

	// The stream in the buffer, which a seek outside the buffer replaces: its
	// controller, and its task, which settles once it lets go of the buffer.
	let stream = new AbortController();
	let task = Promise.resolve();
	let replacing = false; // until the element is seeked into the new stream
	let audio = ""; // the audio track streams carry, "" for the default
	// The stretch that loops, from its first frame to its last, if one does.
	let looping: { start: number; end: number } | undefined;
	// streamFrom puts the server's stream of the Source from the time from in
	// the buffer, in place of the stream there: that one stops, its range and
	// its half-read fragment go, and the new one goes to the same SourceBuffer
	// (#11).
	const streamFrom = (from: number) => {
		stream.abort();
		stream = new AbortController();
		const signal = AbortSignal.any([stop.signal, stream.signal]);
		replacing = true;
		const previous = task;
		task = (async () => {
			await previous;
			const buffer = await opened;
			signal.throwIfAborted(); // replaced by a later seek before it began
			// abort() drops the half-read fragment once remove() is done, which
			// leaves the MediaSource open again if the old stream had ended it.
			await settled(buffer, signal);
			buffer.remove(0, Number.POSITIVE_INFINITY);
			await settled(buffer, signal);
			buffer.abort();
			const res = await fetch(
				`/api/source/stream?${new URLSearchParams({ path, from: String(from), audio })}`,
				{ signal },
			);
			if (!res.ok || !res.body) throw new Error((await res.text()).trim());
			const carries = res.headers.get("Content-Type") ?? type;
			if (carries !== type) {
				buffer.changeType(carries);
				type = carries;
			}
			const reader = res.body.getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				await append(video, buffer, value, signal);
				if (replacing) arrive(from);
				// Then the stream runs at most AHEAD_S ahead of the playhead, and
				// while a stretch loops, no further than its end, so the browser
				// keeps the loop's start rather than freeing it for what comes after.
				else
					while (
						ahead(video) > AHEAD_S ||
						(looping && buffered(video, looping.end))
					)
						await once(video, "timeupdate", signal);
			}
			// A time past the video's last frame never arrives: the last frame
			// shows instead.
			const ranges = video.buffered;
			if (replacing && ranges.length)
				arrive(ranges.end(ranges.length - 1) - frameLength / 2);
			mediaSource.endOfStream();
		})().catch((err: Error) => {
			if (!signal.aborted) fail(err.message);
		});
	};
	// arrive seeks the element to from once the buffer holds that frame, or to
	// the Source's first frame when from is before it: the first frame isn't
	// always at 0, and WebKit plays only from where every track has started
	// (#11). Only then, since WebKit can end a seek still waiting for its frame
	// on the next keyframe.
	const arrive = (from: number) => {
		if (!video.buffered.length) return;
		const to = Math.max(from, video.buffered.start(0) + frameLength / 2);
		if (!buffered(video, to)) return;
		replacing = false;
		video.currentTime = aim = to;
	};
	streamFrom(0);

	const seek = (time: number) => {
		if (Number.isNaN(video.duration)) return; // until the stream begins
		// The last frame's middle at most, which the buffer can hold.
		aim = Math.min(Math.max(time, 0), video.duration - frameLength / 2);
		if (replacing || !buffered(video, aim)) streamFrom(aim);
		else video.currentTime = aim;
	};
	// loopBack seeks to the loop's start when always, or when the frame aimed at
	// is outside the loop or on its last frame, and tells whether it did.
	// Seeking back once the last frame shows keeps every other frame off
	// screen, though WebKit holds the last one about a quarter second (#11). It
	// aims a millisecond into the start's frame, a keyframe, rather than at its
	// middle, which leaves it half its time: Chrome skips it when a refresh
	// comes late.
	const loopBack = (always = false) => {
		if (!looping || (!always && looping.start <= aim && aim < looping.end))
			return false;
		seek(looping.start + 0.001);
		return true;
	};
	return {
		seek,
		playhead: () => aim,
		jump: (seconds) => seek(aim + seconds),
		step: (frames) => seek(aim + frames * frameLength),
		loop: (start, end) => {
			const off = !looping;
			looping =
				start === undefined || end === undefined ? undefined : { start, end };
			// Turned on, it plays from the start; moved, from there only when the
			// frame aimed at is now outside it.
			if (loopBack(off)) video.play().catch(() => {});
		},
		switchAudio: (track) => {
			audio = String(track);
			streamFrom(aim);
		},
		stop: () => {
			stop.abort();
			URL.revokeObjectURL(video.src);
			video.removeAttribute("src");
			video.load(); // detaches the MediaSource
		},
	};
}

// append adds chunk to buffer. When the browser has no room left for it, it
// waits for the playhead to move on, which frees what's behind it, and tries
// again.
async function append(
	video: HTMLVideoElement,
	buffer: SourceBuffer,
	chunk: Uint8Array<ArrayBuffer>,
	signal: AbortSignal,
) {
	for (;;) {
		try {
			buffer.appendBuffer(chunk);
			return await settled(buffer, signal);
		} catch (err) {
			if ((err as DOMException).name !== "QuotaExceededError") throw err;
			await once(video, "timeupdate", signal);
		}
	}
}

// settled resolves once buffer has done what it was doing. An updateend can
// be an earlier operation's, come late, so it waits until buffer isn't
// updating.
async function settled(buffer: SourceBuffer, signal: AbortSignal) {
	while (buffer.updating) await once(buffer, "updateend", signal);
}

// ahead is how far, in seconds, video's buffer runs past its playhead.
function ahead(video: HTMLVideoElement) {
	const { buffered, currentTime } = video;
	return buffered.length ? buffered.end(buffered.length - 1) - currentTime : 0;
}

// buffered tells whether video's buffer holds time.
function buffered({ buffered }: HTMLVideoElement, time: number) {
	for (let i = 0; i < buffered.length; i++)
		if (buffered.start(i) <= time && time < buffered.end(i)) return true;
	return false;
}

/** Fetches the JSON at url, or throws what the server says went wrong. */
export async function getJSON<T>(url: string, signal: AbortSignal): Promise<T> {
	const res = await fetch(url, { signal });
	if (!res.ok) throw new Error((await res.text()).trim());
	return res.json();
}

// once resolves on target's next event of type, and rejects when signal
// aborts.
function once(target: EventTarget, type: string, signal: AbortSignal) {
	return new Promise<void>((resolve, reject) => {
		signal.throwIfAborted();
		const aborted = () => reject(signal.reason);
		signal.addEventListener("abort", aborted, { once: true });
		target.addEventListener(
			type,
			() => {
				signal.removeEventListener("abort", aborted);
				resolve();
			},
			{ once: true, signal },
		);
	});
}
