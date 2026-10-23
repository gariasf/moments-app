import { ArrowLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { around, type Frames, type Marks, noMarks, press, seek } from "./marks";
import { type AudioTrack, getJSON, type Playback, playSource } from "./player";
import { SourceBrowser } from "./SourceBrowser";

type Source = { path: string; sourceName: string };

// The Trimmer opens on its Source browser and plays the Source picked there.
export function Trimmer({ onBack }: { onBack: () => void }) {
	const [source, setSource] = useState<Source>();
	return (
		<>
			<header className="flex items-center gap-2 px-4 py-3">
				<Button
					variant="ghost"
					className="-ml-2.5"
					onClick={source ? () => setSource(undefined) : onBack}
				>
					<ArrowLeft />
					{source ? "Sources" : "Library"}
				</Button>
				<h1 className="truncate font-heading font-semibold text-lg">
					{source?.sourceName ?? "Trimmer"}
				</h1>
			</header>
			<main className="mx-auto w-full max-w-5xl px-4 pb-6">
				{source && <Player key={source.path} path={source.path} />}
				{/* Kept while a Source plays, so going back finds the same folder or
				search. */}
				<div hidden={!!source} className="mx-auto max-w-3xl">
					<SourceBrowser onOpen={setSource} />
				</div>
			</main>
		</>
	);
}

// Player plays the Source at path from its start. Space or a click plays and
// pauses it, J and L jump 10 s back and forward, and ← and → step a frame
// while paused and 5 s while playing. I and O mark a Moment's start and end
// (marks.ts), and Esc clears them. Once both are marked, the marked stretch
// loops until a seek away from it, and \ turns the loop off and on. A Source
// with several audio tracks plays its default until another is picked.
function Player({ path }: { path: string }) {
	const video = useRef<HTMLVideoElement>(null);
	const playback = useRef<Playback>(null);
	const [problem, setProblem] = useState("");
	const [time, setTime] = useState(0);
	const [duration, setDuration] = useState(0);
	const [rate, setRate] = useState(1);
	const [tracks, setTracks] = useState<AudioTrack[]>([]);
	const [track, setTrack] = useState(0); // the one playing, from 0
	const [marks, setMarks] = useState(noMarks);
	useEffect(() => {
		if (!video.current) return;
		playback.current = playSource(
			video.current,
			path,
			setProblem,
			undefined,
			({ audioTracks = [] }) => {
				setTracks(audioTracks);
				setTrack(audioTracks.findIndex((t) => t.default));
			},
		);
		return playback.current.stop;
	}, [path]);
	useEffect(() => {
		if (video.current) video.current.playbackRate = rate;
	}, [rate]);
	useEffect(() => {
		if (marks.loop) playback.current?.loop(marks.start, marks.end);
		else playback.current?.loop();
	}, [marks]);
	useEffect(() => {
		// A mark waits for the frames around it, and marks follow one another
		// in the order their keys were pressed.
		const stop = new AbortController();
		let marking = Promise.resolve();
		// moved tells the marks where a seek went: away from them, the loop stops.
		const moved = (p: Playback) => setMarks((m) => seek(m, p.playhead()));
		const onKey = (e: KeyboardEvent) => {
			const [v, p] = [video.current, playback.current];
			const key = e.key.toLowerCase();
			// But \, typed with ⌥ on a Spanish keyboard, and ⌥⇧ on a German one.
			const modified =
				e.metaKey || e.ctrlKey || (key !== "\\" && (e.altKey || e.shiftKey));
			if (!v || !p || modified) return;
			// Keys picking from a list, such as the audio tracks', are the list's.
			if (e.target instanceof Element && e.target.closest("[role=listbox]"))
				return;
			switch (key) {
				case " ":
					if (!e.repeat) toggle(v);
					break;
				case "j":
					p.jump(-10);
					moved(p);
					break;
				case "l":
					p.jump(10);
					moved(p);
					break;
				case "arrowleft":
					if (v.paused) p.step(-1);
					else p.jump(-5);
					moved(p);
					break;
				case "arrowright":
					if (v.paused) p.step(1);
					else p.jump(5);
					moved(p);
					break;
				case "i":
				case "o":
				case "\\":
				case "escape": {
					if (e.repeat) break;
					const at = p.playhead();
					marking = marking
						.then(() => framesAround(path, around(key, at), stop.signal))
						.then((frames) => setMarks((m) => press(m, key, at, frames)))
						.catch(() => {}); // a mark the server can't place isn't made
					break;
				}
				default:
					return;
			}
			e.preventDefault(); // no scrolling, and no click on a focused button
			e.stopPropagation(); // nor a pick by first letter on the focused picker
		};
		// Before the page's own handlers, so the keys are the Trimmer's wherever
		// the focus is, but in a list.
		addEventListener("keydown", onKey, true);
		return () => {
			stop.abort();
			removeEventListener("keydown", onKey, true);
		};
	}, [path]);
	return (
		<div className="flex flex-col gap-2">
			{problem && (
				<p
					role="alert"
					className="grid aspect-video place-items-center rounded-lg bg-muted p-6 text-center text-muted-foreground text-sm"
				>
					{problem}
				</p>
			)}
			{/* biome-ignore lint/a11y/useMediaCaption: no subtitles in v1 (#17) */}
			<video
				ref={video}
				hidden={!!problem}
				playsInline
				onClick={() => toggle(video.current)}
				onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
				// NaN once the Source is gone
				onDurationChange={(e) => setDuration(e.currentTarget.duration || 0)}
				className="aspect-video w-full rounded-lg bg-black"
			/>
			<div hidden={!!problem} className="flex items-center gap-3">
				<SeekBar
					path={path}
					time={time}
					duration={duration}
					marks={marks}
					onSeek={(to) => {
						playback.current?.seek(to);
						setMarks((m) => seek(m, to));
					}}
				/>
				<div className="flex">
					{[1, 1.5, 2].map((r) => (
						<Button
							key={r}
							size="sm"
							variant={r === rate ? "secondary" : "ghost"}
							aria-pressed={r === rate}
							onClick={() => setRate(r)}
						>
							{r}×
						</Button>
					))}
				</div>
				{tracks.length > 1 && (
					<AudioPicker
						tracks={tracks}
						track={track}
						onPick={(n) => {
							setTrack(n);
							playback.current?.switchAudio(n);
						}}
					/>
				)}
			</div>
			<p role="status" hidden={!!problem} className="min-h-5 text-sm">
				{marks.note && `Start: ${marks.note}`}
			</p>
			<p hidden={!!problem} className="text-muted-foreground text-xs">
				Space or a click plays and pauses. J and L jump 10 s; ← and → step a
				frame while paused, and 5 s while playing. I and O mark the start and
				end, which then loop until you seek away; \ turns the loop off and on,
				and Esc clears the marks.
			</p>
		</div>
	);
}

// AudioPicker lists a Source's audio tracks, with the one playing, track, and
// gives onPick the one picked, each counted from 0.
function AudioPicker({
	tracks,
	track,
	onPick,
}: {
	tracks: AudioTrack[];
	track: number;
	onPick: (track: number) => void;
}) {
	const items = tracks.map((t, i) => ({ label: trackName(t), value: i }));
	return (
		<Select
			items={items}
			value={track}
			// Picking the track playing again, too, calls this.
			onValueChange={(n) => n !== null && n !== track && onPick(n)}
		>
			<SelectTrigger size="sm" aria-label="Audio track">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{items.map(({ label, value }) => (
					<SelectItem key={value} value={value}>
						{label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

// Languages' names, in the page's language.
const languages = new Intl.DisplayNames("en", { type: "language" });

// trackName names an audio track by its language, codec and channels, such as
// "English · E-AC-3 5.1".
function trackName({ language, codec, channels }: AudioTrack) {
	const layout =
		{ 1: "mono", 2: "stereo", 6: "5.1", 7: "6.1", 8: "7.1" }[channels] ??
		`${channels} channels`;
	let name = "";
	try {
		// und is undetermined
		if (language && language !== "und") name = languages.of(language) ?? "";
	} catch {
		name = language ?? ""; // a tag that isn't a language's
	}
	return [name, `${codec} ${layout}`].filter(Boolean).join(" · ");
}

// The width of the seek bar's hover tip, in CSS pixels: its thumbnail is 320
// pixels wide, for screens with two pixels to each.
const TIP_WIDTH = 160;

// SeekBar shows time out of duration, in seconds of the own time of the Source
// at path, with the marks, and seeks to the spot clicked. Hovering over a spot
// shows its time and a thumbnail of the keyframe at or before it (media.go).
function SeekBar({
	path,
	time,
	duration,
	marks,
	onSeek,
}: {
	path: string;
	time: number;
	duration: number;
	marks: Marks;
	onSeek: (time: number) => void;
}) {
	// The spot hovered over, and where its thumbnail goes, along the bar.
	const [hover, setHover] = useState<{ time: number; left: number }>();
	const thumbnail = useLatestImage(
		hover &&
			`/api/source/thumbnail?${new URLSearchParams({ path, at: hover.time.toFixed(3) })}`,
	);
	const along = (t: number) => `${duration ? (t / duration) * 100 : 0}%`;
	return (
		<div className="flex flex-1 items-center gap-3 text-muted-foreground text-xs tabular-nums">
			{clock(time, duration)}
			<div
				role="slider"
				tabIndex={-1}
				aria-label="Seek"
				aria-valuemin={0}
				aria-valuemax={duration}
				aria-valuenow={time}
				aria-valuetext={clock(time, duration)}
				onPointerDown={(e) => {
					const bar = e.currentTarget.getBoundingClientRect();
					onSeek(((e.clientX - bar.left) / bar.width) * duration);
				}}
				onPointerMove={(e) => {
					if (!duration) return; // no spot has a time until the Source opens
					const bar = e.currentTarget.getBoundingClientRect();
					// By whole pixels, so a spot hovered over again has its
					// thumbnail cached.
					const x = Math.round(e.clientX - bar.left);
					setHover({
						time: (Math.min(Math.max(x, 0), bar.width) / bar.width) * duration,
						left: Math.min(
							Math.max(x, TIP_WIDTH / 2),
							bar.width - TIP_WIDTH / 2,
						),
					});
				}}
				onPointerLeave={() => setHover(undefined)}
				className="relative h-1.5 flex-1 cursor-pointer rounded-full bg-muted before:absolute before:-inset-y-2 before:inset-x-0"
			>
				<div
					className="h-full rounded-full bg-primary"
					style={{ width: along(time) }}
				/>
				{marks.start !== undefined && marks.end !== undefined && (
					<div
						aria-hidden
						className="absolute inset-y-0 bg-amber-400/50"
						style={{
							left: along(marks.start),
							width: along(marks.end - marks.start),
						}}
					/>
				)}
				{(["start", "end"] as const).map((edge) => {
					const at = marks[edge];
					return (
						at !== undefined && (
							<div
								key={edge}
								aria-hidden
								className="absolute -inset-y-1.5 w-0.5 -translate-x-1/2 rounded-full bg-amber-400"
								style={{ left: along(at) }}
							/>
						)
					);
				})}
				{hover && (
					<div
						aria-hidden
						className="pointer-events-none absolute bottom-full mb-3 -translate-x-1/2 overflow-hidden rounded-md border bg-black text-center text-white"
						style={{ left: hover.left, width: TIP_WIDTH }}
					>
						{thumbnail ? (
							<img
								src={thumbnail}
								alt=""
								className="aspect-video w-full object-contain"
							/>
						) : (
							<div className="aspect-video" />
						)}
						<div className="py-0.5">{clock(hover.time, duration)}</div>
					</div>
				)}
			</div>
			{clock(duration, duration)}
		</div>
	);
}

// framesAround asks the server where a Moment of the Source at path can start
// and end around each of times (media.go), in one list.
async function framesAround(
	path: string,
	times: number[],
	signal: AbortSignal,
): Promise<Frames> {
	const all = await Promise.all(
		times.map((at) =>
			getJSON<Frames>(
				`/api/source/frames?${new URLSearchParams({ path, at: String(at) })}`,
				signal,
			),
		),
	);
	return {
		keyframes: all.flatMap((f) => f.keyframes),
		cleanEnds: all.flatMap((f) => f.cleanEnds),
	};
}

// useLatestImage loads the image at url, and returns the URL of the latest one
// loaded, until url is undefined. While one loads, a newer url waits for it
// rather than piling up, since the pointer moves faster than the Umbrel makes
// thumbnails.
function useLatestImage(url?: string) {
	const [loaded, setLoaded] = useState<string>();
	const wanted = useRef(url);
	const loading = useRef(false);
	useEffect(() => {
		wanted.current = url;
		if (!url) setLoaded(undefined);
		if (!url || loading.current) return;
		const load = (src: string) => {
			loading.current = true;
			const image = new Image();
			image.onload = () => {
				if (wanted.current) setLoaded(src);
				next(src);
			};
			image.onerror = () => next(src);
			image.src = src;
		};
		const next = (done: string) => {
			loading.current = false;
			if (wanted.current && wanted.current !== done) load(wanted.current);
		};
		load(url);
	}, [url]);
	return loaded;
}

// clock writes seconds as hh:mm:ss, or as mm:ss when the Source, of length
// duration, is under an hour.
function clock(seconds: number, duration: number) {
	return new Date(seconds * 1000)
		.toISOString()
		.slice(duration < 3600 ? 14 : 11, 19);
}

function toggle(video: HTMLVideoElement | null) {
	if (video?.paused) video.play().catch(() => {});
	else video?.pause();
}
