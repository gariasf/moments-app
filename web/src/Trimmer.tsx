import { cn } from "cn";
import {
	ChevronLeft,
	ChevronRight,
	ChevronsLeft,
	ChevronsRight,
	Pause,
	Play,
	X,
} from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
	AlertDialog,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	around,
	clear,
	FAR,
	type Frames,
	type Marks,
	type Nudge,
	noMarks,
	nudge,
	prefill,
	press,
	type Span,
	seek,
	setAt,
	span,
	typed,
	typedSpan,
} from "./marks";
import { type AudioTrack, getJSON, type Playback, playSource } from "./player";
import { Toolbar, useLeaveGuard, useShell } from "./Shell";
import { type Place, SourceBrowser, type Video } from "./SourceBrowser";
import { anyOnItsWay, type Save, saveStatus } from "./saves";
import { useTabTitle } from "./title";
import { formatSize } from "./upload";

type Moment = {
	title: string;
	length: number;
	sourcePath?: string;
	start: number;
	end: number;
	last?: number;
};

type Made = {
	key: string;
	title: string;
	start: number;
	end: number;
	marks?: { start: number; end: number };
	save?: Save;
	length?: number;
};

async function askForSave(url: string, request: RequestInit): Promise<Save> {
	const response = await fetch(url, request);
	if (!response.ok) throw new Error((await response.text()).trim());
	return { ...((await response.json()) as Save), answered: performance.now() };
}

// What GET /api/mounts answers (main.go): how the server finds the folders
// the package mounts, "" being Home, and how each should be.
type Mount = {
	path: string;
	access: "read-only" | "writable" | "missing";
	want: "read-only" | "writable";
};

export function Trimmer({ place }: { place: Place }) {
	const [source, setSource] = useState<Video>();
	const [asking, setAsking] = useState(false);
	const [afterLeaving, setAfterLeaving] = useState<() => void>();
	const leave = () => {
		setAsking(false);
		setSource(undefined);
		setAfterLeaving(undefined);
		afterLeaving?.();
	};
	const askFirst = (afterAnswer: () => void) => {
		setAfterLeaving(() => afterAnswer);
		setAsking(true);
	};
	const open = (video: Video) => {
		if (video.path === source?.path) return;
		if (source?.deletable) askFirst(() => setSource(video));
		else setSource(video);
	};
	const done = source?.deletable ? () => setAsking(true) : leave;
	const [placeShown, setPlaceShown] = useState(place);
	if (place !== placeShown) {
		setPlaceShown(place);
		// Below md the list is hidden while a Source plays.
		if (source && matchMedia("(width < 48rem)").matches) done();
	}
	useLeaveGuard(source?.deletable ? askFirst : undefined);
	useTabTitle(source?.sourceName ?? "Trimmer");
	return (
		<div className="grid flex-1 content-start md:content-stretch md:grid-cols-[20rem_minmax(0,1fr)] md:grid-rows-[auto_1fr]">
			<Toolbar>
				<h1 className="min-w-0 truncate font-heading text-lg">
					{source?.sourceName ?? "Trimmer"}
				</h1>
				{source && (
					<>
						<span className="shrink-0 text-muted-foreground text-sm tabular-nums">
							{formatSize(source.size)}
						</span>
						<Button variant="ghost" className="ml-auto" onClick={done}>
							Done
						</Button>
					</>
				)}
			</Toolbar>
			<div
				className={cn(
					"md:sticky md:top-0 md:col-start-1 md:row-span-2 md:row-start-1 md:h-svh md:self-start md:border-r",
					source && "hidden md:block",
				)}
			>
				<SourceBrowser place={place} playing={source?.path} onOpen={open} />
			</div>
			{source ? (
				<main className="mx-auto w-full max-w-5xl p-4 pb-6 md:col-start-2 md:p-5">
					<Player
						key={source.path}
						{...source}
						asking={asking}
						onStay={() => {
							setAsking(false);
							setAfterLeaving(undefined);
						}}
						onLeave={leave}
					/>
				</main>
			) : (
				<NoSource />
			)}
		</div>
	);
}

function NoSource() {
	const [mounts, setMounts] = useState<Mount[]>([]);
	useEffect(() => {
		getJSON<Mount[]>("/api/mounts")
			.then(setMounts)
			.catch(() => {}); // the Source list reports a server that can't be reached
	}, []);
	return (
		<main className="grid place-items-center p-6 text-center md:col-start-2">
			<div className="flex max-w-sm flex-col gap-3">
				<p className="hidden text-muted-foreground text-sm md:block">
					Pick a Source on the left, or drop a video there.
				</p>
				<p className="text-muted-foreground text-xs">
					{mounts.map((mount) => (
						<span
							key={mount.path}
							className={
								mount.access === mount.want ? undefined : "text-destructive"
							}
						>
							{mount.path || "Home"} is {mount.access}
							{mount.access !== mount.want && `, and should be ${mount.want}`}.{" "}
						</span>
					))}
				</p>
			</div>
		</main>
	);
}

// Player plays the Source at path from its start. Space or a click plays and
// pauses it, J and L jump 10 s back and forward, and ← and → step a frame
// while paused and 5 s while playing. I and O mark a Moment's start and end
// (marks.ts), and Esc clears them. Once both are marked, the marked stretch
// loops until a seek away from it, and \ turns the loop off and on. With the
// edge selected marked, ← and → nudge it, and ⇧← and ⇧→ further, as the
// nudge buttons do, and Tab selects the other edge. A Source with several
// audio tracks plays its default until another is picked. Enter or Save saves
// the marked Moment, with the audio track playing, under the title in its
// field, prefilled from sourceName and the start: the marks clear, playback
// carries on from the end, and the Save shows until it's saved.
function Player({
	path,
	sourceName,
	name,
	size,
	asking,
	onStay,
	onLeave,
}: Video & { asking: boolean; onStay: () => void; onLeave: () => void }) {
	const { setLibrary } = useShell();
	const video = useRef<HTMLVideoElement>(null);
	const playback = useRef<Playback>(null);
	const [problem, setProblem] = useState("");
	const [time, setTime] = useState(0);
	const [paused, setPaused] = useState(true);
	const [duration, setDuration] = useState(0);
	const [rate, setRate] = useState(1);
	const [tracks, setTracks] = useState<AudioTrack[]>([]);
	const [track, setTrack] = useState(0); // the one playing, from 0
	const [marks, setMarks] = useState(noMarks);
	// The marks as the latest change left them, which keys read before React
	// renders them.
	const latest = useRef(noMarks);
	const change = useCallback((edit: (marks: Marks) => Marks) => {
		latest.current = edit(latest.current);
		setMarks(latest.current);
	}, []);
	// What the nudge buttons call, set by the keys' effect, so that their nudges
	// wait their turn with the keys'.
	const nudging = useRef<(nudge: Nudge) => void>(undefined);
	const editing = useRef<EdgeEdits>(undefined);
	// The title the owner typed, else the field shows the prefilled one.
	const [title, setTitle] = useState<string>();
	const [saves, setSaves] = useState<Save[]>([]); // in the order made
	const [moments, setMoments] = useState<Moment[]>([]); // oldest first
	const savesNow = useRef(saves);
	savesNow.current = saves;
	const lastFrames = useRef(new Map<number, number>());
	const refused = useRef(0); // how many Saves the server refused
	// What Enter, Save and the title field call, set by the keys' effect, so a
	// Save waits for the marks pressed before it; and the save it calls, as the
	// latest render has the title and audio track.
	const saving = useRef<() => void>(undefined);
	const saveMarks = useRef<() => void>(undefined);
	const put = (save: Save, replacing?: number) =>
		setSaves((all) =>
			replacing === undefined
				? [...all, save]
				: all.map((other) => (other.id === replacing ? save : other)),
		);
	const send = (sent: string, replacing?: number) =>
		askForSave("/api/saves", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: sent,
		}).then(
			(made) => put(made, replacing),
			(error: Error) =>
				put(
					{
						...JSON.parse(sent),
						id: -++refused.current,
						state: "failed",
						error: error.message,
						sent,
					},
					replacing,
				),
		);
	const retry = (save: Save) => {
		if (save.sent) {
			send(save.sent, save.id);
			return;
		}
		askForSave(`/api/saves/${save.id}/retry`, { method: "POST" }).then(
			(made) => put(made, save.id),
			(error: Error) => put({ ...save, error: error.message }, save.id),
		);
	};
	const dismiss = async (save: Save) => {
		try {
			if (!save.sent) {
				const response = await fetch(`/api/saves/${save.id}`, {
					method: "DELETE",
				});
				if (!response.ok && response.status !== 404)
					throw new Error((await response.text()).trim());
			}
		} catch (error) {
			put(
				{ ...save, error: `Dismiss failed: ${(error as Error).message}` },
				save.id,
			);
			return;
		}
		setSaves((all) => all.filter((other) => other.id !== save.id));
	};
	const made: Made[] = [
		...moments.map((moment) => ({
			key: `moment ${moment.start} ${moment.end} ${moment.title}`,
			title: moment.title,
			start: moment.start,
			end: moment.end,
			length: moment.length,
			marks:
				moment.last === undefined
					? undefined
					: { start: moment.start, end: moment.last },
		})),
		...saves.map((save) => ({
			key: `save ${save.id}`,
			title: save.title,
			start: save.start,
			end: save.end,
			marks: { start: save.start, end: save.end },
			save,
		})),
	];
	const taken = ({ start, end }: Marks) =>
		made.some((item) => item.marks?.start === start && item.marks?.end === end);
	const loadMoments = async (signal: AbortSignal) => {
		const library = await getJSON<Moment[]>("/api/moments", signal);
		setLibrary(library);
		const fromHere = library
			.filter((moment) => moment.sourcePath === path)
			.reverse();
		return Promise.all(
			fromHere.map(async (moment) => {
				const end = moment.end || moment.start + moment.length;
				const before = end - 0.001;
				if (!lastFrames.current.has(end)) {
					const frames = await framesAround(
						path,
						[[before, before]],
						signal,
					).catch(() => undefined);
					const ends = (frames?.cleanEnds ?? []).filter(
						(time) => time <= before,
					);
					if (ends.length) lastFrames.current.set(end, Math.max(...ends));
				}
				return { ...moment, end, last: lastFrames.current.get(end) };
			}),
		);
	};
	const newestApplied = useRef(0);
	const refresh =
		useRef<(signal: AbortSignal, withMoments?: boolean) => void>(undefined);
	refresh.current = async (signal, withMoments) => {
		const asked = performance.now();
		const listed = await getJSON<Save[]>("/api/saves", signal).catch(
			() => undefined,
		);
		if (!listed) return;
		const ours = listed.filter((save) => save.path === path);
		const unlisted = (save: Save) =>
			!ours.some((other) => other.id === save.id);
		// A list asked for before the server took a Save doesn't hold it yet.
		const pending = (save: Save) => save.id < 0 || (save.answered ?? 0) > asked;
		const done = savesNow.current.some(
			(save) => unlisted(save) && !pending(save),
		);
		let fromHere: Moment[] | undefined;
		if (withMoments || done) {
			fromHere = await loadMoments(signal).catch(() => undefined);
			if (!fromHere) return;
		}
		if (fromHere) setMoments(fromHere);
		if (asked < newestApplied.current) return;
		newestApplied.current = asked;
		setSaves((all) => [
			...ours,
			...all.filter((save) => unlisted(save) && pending(save)),
		]);
	};
	useEffect(() => {
		saveMarks.current = () => {
			const { start, end } = latest.current;
			if (start === undefined || end === undefined || taken(latest.current))
				return;
			const named = title?.trim() || prefill(sourceName, start);
			change(() => noMarks);
			setTitle(undefined);
			// Playback carries on from the end's frame, a millisecond in, as the
			// loop's start; without the loop, which would go back from there. The
			// Save is sent even once the Source is closed, as Enter asked.
			playback.current?.loop();
			playback.current?.seek(end + 0.001);
			video.current?.play().catch(() => {});
			const audio = track < 0 ? undefined : track;
			send(JSON.stringify({ path, start, end, audio, title: named }));
		};
	});
	useEffect(() => {
		const stop = new AbortController();
		refresh.current?.(stop.signal, true);
		return () => stop.abort();
	}, []);
	useEffect(() => {
		if (!asking) return;
		const stop = new AbortController();
		refresh.current?.(stop.signal, true);
		return () => stop.abort();
	}, [asking]);
	const onItsWay = anyOnItsWay(saves);
	useEffect(() => {
		if (!onItsWay) return;
		const stop = new AbortController();
		const poll = () => refresh.current?.(stop.signal);
		poll();
		const every = setInterval(poll, 1000);
		return () => {
			clearInterval(every);
			stop.abort();
		};
	}, [onItsWay]);
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
		let queued = 0; // marks waiting their turn
		const later = (mark: () => Promise<void>) => {
			queued++;
			marking = marking
				.then(mark)
				.catch(() => {}) // a mark the server can't place isn't made
				.finally(() => queued--);
		};
		// moved tells the marks where a seek went: away from them, the loop stops.
		const moved = (p: Playback) => change((m) => seek(m, p.playhead()));
		// move nudges a button's edge, or an arrow's, the one selected by the time
		// its turn comes, and the preview holds on it (player.ts). An arrow with
		// that edge unmarked steps the playhead: a frame while paused, 5 s while
		// playing.
		const move = (n: Nudge) =>
			later(async () => {
				const [v, p] = [video.current, playback.current];
				const over = span(latest.current, n);
				if (over) {
					const frames = await framesAround(path, [over], stop.signal);
					const { marks: next, preview } = nudge(latest.current, n, frames);
					change(() => next);
					if (preview)
						p?.hold(preview.hold, preview.play, next.start, next.end);
				} else if (!n.edge && !n.far && v && p) {
					if (v.paused) p.step(n.by);
					else p.jump(5 * n.by);
					moved(p);
				}
			});
		nudging.current = move;
		editing.current = {
			clear: (edge) => later(async () => change((marks) => clear(marks, edge))),
			reset: () => later(async () => change(() => noMarks)),
			type: (edge, text) =>
				new Promise((resolve) =>
					later(async () => {
						const duration = video.current?.duration || Infinity;
						const time = typed(latest.current, edge, text, duration);
						if (typeof time === "string") return resolve(time);
						const frames = await framesAround(
							path,
							[typedSpan(time)],
							stop.signal,
						).catch(() => undefined);
						if (!frames) return resolve("The frames there didn't load");
						const placed = setAt(latest.current, edge, time, frames);
						if (typeof placed === "string") return resolve(placed);
						change(() => placed);
						resolve("");
					}),
				),
		};
		saving.current = () => later(async () => saveMarks.current?.());
		const onKey = (e: KeyboardEvent) => {
			const [v, p] = [video.current, playback.current];
			const key = e.key.toLowerCase();
			const arrowKey = key === "arrowleft" || key === "arrowright";
			// But \, typed with ⌥ on a Spanish keyboard, and ⌥⇧ on a German one,
			// and ⇧← and ⇧→, which nudge further.
			const modified =
				e.metaKey ||
				e.ctrlKey ||
				(key !== "\\" && (e.altKey || (e.shiftKey && !arrowKey)));
			if (!v || !p || modified || !v.checkVisibility()) return;
			// Keys picking from a list, such as the audio tracks', are the list's,
			// and keys typed into the title are the title's: Enter there submits
			// it, and Esc gives the keys back.
			if (
				e.target instanceof Element &&
				e.target.closest("[role=listbox],[role=alertdialog]")
			)
				return;
			if (e.target instanceof HTMLInputElement) {
				if (key === "escape") e.target.blur();
				return;
			}
			// With no edge to select, nor one on its way, Tab moves the focus, as
			// anywhere, and with no Moment to save, Enter presses the button focused.
			const marked = latest.current;
			if (key === "tab" && marked.start === undefined && !queued) return;
			const whole = marked.start !== undefined && marked.end !== undefined;
			if (key === "enter" && !whole && !queued) return;
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
				case "arrowright":
					// Held down, an arrow goes as fast as the server answers.
					if (!e.repeat || !queued)
						move({ by: key === "arrowleft" ? -1 : 1, far: e.shiftKey });
					break;
				case "enter":
					if (!e.repeat) saving.current?.();
					break;
				case "i":
				case "o":
				case "\\":
				case "escape":
				case "tab": {
					if (e.repeat) break;
					const at = p.playhead();
					later(async () => {
						const spans = around(key, at);
						const frames = await framesAround(path, spans, stop.signal);
						change((m) => press(m, key, at, frames));
					});
					break;
				}
				default:
					return;
			}
			e.preventDefault(); // no scrolling, and no click on a focused button
			e.stopPropagation(); // nor a pick by first letter on the focused picker
		};
		// Before the page's own handlers, so the keys are the Trimmer's wherever
		// the focus is, but in a list or the title.
		addEventListener("keydown", onKey, true);
		return () => {
			stop.abort();
			nudging.current = saving.current = editing.current = undefined;
			removeEventListener("keydown", onKey, true);
		};
	}, [path, change]);
	const playOrPause = paused ? "Play" : "Pause";
	const markedLength =
		marks.start === undefined || marks.end === undefined
			? undefined
			: marks.end - marks.start;
	return (
		<div>
			{/* 6rem is the Toolbar's h-14 plus main's md:p-5, top and bottom. */}
			<div className="flex flex-col gap-2 md:max-h-[calc(100svh-6rem)]">
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
					onPlay={() => setPaused(false)}
					onPause={() => setPaused(true)}
					onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
					// NaN once the Source is gone
					onDurationChange={(e) => setDuration(e.currentTarget.duration || 0)}
					className="aspect-video min-h-0 w-full rounded-lg bg-black"
				/>
				<div
					hidden={!!problem}
					className="flex flex-col gap-3 rounded-lg border bg-black/30 p-3"
				>
					<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums">
						<Button
							variant="secondary"
							size="sm"
							aria-label={playOrPause}
							aria-keyshortcuts="Space"
							title={`${playOrPause} (Space, or a click on the video)`}
							onClick={() => toggle(video.current)}
						>
							{paused ? <Play /> : <Pause />}
							<KeyHint>Space</KeyHint>
						</Button>
						<span className="font-semibold text-sm">
							{clock(time, duration, true)}
						</span>
						<span className="text-muted-foreground">
							/ {clock(duration, duration)}
						</span>
						<span className="ml-auto flex items-center gap-1">
							{tracks.length > 1 && (
								<AudioPicker
									tracks={tracks}
									track={track}
									onPick={(trackIndex) => {
										setTrack(trackIndex);
										playback.current?.switchAudio(trackIndex);
									}}
								/>
							)}
							{[1, 1.5, 2].map((speed) => (
								<Button
									key={speed}
									size="xs"
									variant={speed === rate ? "secondary" : "ghost"}
									aria-pressed={speed === rate}
									onClick={() => setRate(speed)}
								>
									{speed}×
								</Button>
							))}
						</span>
					</div>
					<SeekBar
						path={path}
						time={time}
						duration={duration}
						marks={marks}
						made={made}
						onSeek={(to) => {
							playback.current?.seek(to);
							change((m) => seek(m, to));
						}}
					/>
					<Edges
						marks={marks}
						duration={duration}
						onNudge={(nudge) => nudging.current?.(nudge)}
						onClear={(edge) => editing.current?.clear(edge)}
						onReset={() => editing.current?.reset()}
						onType={(edge, text) =>
							editing.current?.type(edge, text) ?? Promise.resolve("")
						}
					/>
				</div>
				<p role="status" hidden={!!problem} className="min-h-5 text-sm">
					{marks.note && `Start: ${marks.note}`}
				</p>
				<form
					hidden={!!problem}
					onSubmit={(e) => {
						e.preventDefault();
						// Then the keys are the Trimmer's again.
						if (document.activeElement instanceof HTMLElement)
							document.activeElement.blur();
						saving.current?.();
					}}
					className="flex gap-2"
				>
					<Input
						aria-label="Title"
						placeholder="Title"
						value={
							title ??
							(marks.start === undefined
								? ""
								: prefill(sourceName, marks.start))
						}
						onChange={(e) => setTitle(e.target.value)}
					/>
					<Button
						type="submit"
						aria-keyshortcuts="Enter"
						title="Save the marked Moment under its title (Enter); playback carries on from its end"
						disabled={markedLength === undefined || taken(marks)}
					>
						Save{markedLength !== undefined && ` ${formatLength(markedLength)}`}
						<KeyHint className="bg-primary-foreground/15 text-primary-foreground">
							↵
						</KeyHint>
					</Button>
				</form>
			</div>
			{/* Live, and there from the start, so a screen reader says how each
			Save goes. */}
			<table
				hidden={!!problem}
				aria-label="Made from this Source"
				aria-live="polite"
				className={cn("w-full text-sm", made.length > 0 && "mt-4")}
			>
				{made.length > 0 && (
					<caption className="pb-1 text-left font-semibold text-muted-foreground text-xs uppercase tracking-wider">
						Made from this Source
					</caption>
				)}
				<tbody className="divide-y">
					{made.map(({ key, title, start, marks: madeFrom, save, length }) => (
						<tr key={key}>
							<td className="py-1">
								<Button
									variant="ghost"
									size="xs"
									className="-ml-2 h-auto min-h-6 whitespace-normal text-left font-semibold"
									disabled={!madeFrom}
									title="Mark it again, to loop it"
									onClick={() =>
										madeFrom &&
										change(() => ({
											...madeFrom,
											edge: "end",
											loop: true,
											note: "",
										}))
									}
								>
									{title}
								</Button>
							</td>
							<td className="whitespace-nowrap py-1 pl-4 text-muted-foreground tabular-nums">
								at {formatLength(start)}
							</td>
							<td className="py-1 pl-4 text-right text-muted-foreground tabular-nums">
								{save ? saveStatus(save) : formatLength(length ?? 0)}
								{save?.state === "failed" && (
									<span className="ml-2 inline-flex gap-1">
										<Button
											variant="outline"
											size="xs"
											onClick={() => retry(save)}
										>
											Retry
										</Button>
										<Button
											variant="ghost"
											size="xs"
											onClick={() => dismiss(save)}
										>
											Dismiss
										</Button>
									</span>
								)}
							</td>
						</tr>
					))}
				</tbody>
			</table>
			<DoneSheet
				path={path}
				name={name}
				size={size}
				moments={moments.length}
				saves={saves}
				open={asking}
				onStay={onStay}
				onLeave={onLeave}
			/>
		</div>
	);
}

function DoneSheet({
	path,
	name,
	size,
	moments,
	saves,
	open,
	onStay,
	onLeave,
}: {
	path: string;
	name: string;
	size: number;
	moments: number;
	saves: Save[];
	open: boolean;
	onStay: () => void;
	onLeave: () => void;
}) {
	const [deleting, setDeleting] = useState(false);
	const [problem, setProblem] = useState("");
	const waitingFor = saves.some((save) => save.state === "failed")
		? "Retry or dismiss the failed Save from this Source first: a retry needs it."
		: saves.length
			? "Delete waits until the Saves from this Source are saved."
			: "";
	const deleteSource = async () => {
		setDeleting(true);
		setProblem("");
		try {
			const response = await fetch(
				`/api/sources?${new URLSearchParams({ path })}`,
				{ method: "DELETE" },
			);
			if (!response.ok) throw new Error((await response.text()).trim());
			onLeave();
		} catch (error) {
			setProblem((error as Error).message);
		} finally {
			setDeleting(false);
		}
	};
	return (
		<AlertDialog open={open} onOpenChange={(isOpen) => !isOpen && onStay()}>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>Done with this Source?</AlertDialogTitle>
					<AlertDialogDescription>
						{moments
							? `${moments} ${moments === 1 ? "Moment" : "Moments"} came from it. They keep playing after the Source is gone.`
							: "No Moments came from it."}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<p className="text-sm">
					<span className="break-all font-medium">{name}</span>
					<span className="text-muted-foreground"> · {formatSize(size)}</span>
				</p>
				{waitingFor && (
					<p role="status" className="text-muted-foreground text-sm">
						{waitingFor}
					</p>
				)}
				{problem && (
					<p role="alert" className="text-destructive text-sm">
						{problem}
					</p>
				)}
				<AlertDialogFooter>
					<Button variant="outline" onClick={onLeave}>
						Keep it
					</Button>
					<Button
						variant="destructive"
						disabled={!!waitingFor || deleting}
						onClick={deleteSource}
					>
						Delete the Source
					</Button>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}

function KeyHint({
	children,
	className,
}: {
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<kbd
			aria-hidden
			className={cn(
				"rounded bg-foreground/10 px-1 font-normal font-sans text-[10px] text-muted-foreground pointer-coarse:hidden",
				className,
			)}
		>
			{children}
		</kbd>
	);
}

type EdgeEdits = {
	clear: (edge: Marks["edge"]) => void;
	reset: () => void;
	type: (edge: Marks["edge"], text: string) => Promise<string>;
};

function Edges({
	marks,
	duration,
	onNudge,
	onClear,
	onReset,
	onType,
}: {
	marks: Marks;
	duration: number;
	onNudge: (nudge: Nudge) => void;
	onClear: EdgeEdits["clear"];
	onReset: EdgeEdits["reset"];
	onType: EdgeEdits["type"];
}) {
	return (
		<div className="grid items-start gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
			{(["start", "end"] as const).map((edge) => {
				const name = edge === "start" ? "Start" : "End";
				const markKey = edge === "start" ? "I" : "O";
				const step = edge === "start" ? "a keyframe" : "a frame it can end on";
				const about = `about ${FAR[edge]} s`;
				const edgeTime = marks[edge];
				const selected = edgeTime !== undefined && marks.edge === edge;
				return (
					<div
						key={edge}
						title={`${markKey} marks the ${edge} at the playhead. Once both are marked, they loop until you seek away; \\ turns the loop off and on. Tab selects the other edge, and Esc clears the marks.`}
						className={cn(
							"flex flex-wrap items-center gap-1 rounded-md py-1 pr-1 pl-2.5 text-xs ring-1",
							selected ? "bg-primary/10 ring-primary/60" : "ring-border",
						)}
					>
						<span className="font-semibold">{name}</span>
						<KeyHint>{markKey}</KeyHint>
						<EdgeTime
							name={name}
							shown={
								edgeTime === undefined ? "" : clock(edgeTime, duration, true)
							}
							onType={(text) => onType(edge, text)}
						/>
						<Button
							size="icon-sm"
							variant="ghost"
							disabled={edgeTime === undefined}
							aria-label={`Clear the ${edge}`}
							title={`Clear the ${edge}, and keep the ${edge === "start" ? "end" : "start"}`}
							onClick={() => onClear(edge)}
						>
							<X />
						</Button>
						{(
							[
								[-1, true, ChevronsLeft, `${about} earlier`, "⇧←"],
								[-1, false, ChevronLeft, `${step} earlier`, "←"],
								[1, false, ChevronRight, `${step} later`, "→"],
								[1, true, ChevronsRight, `${about} later`, "⇧→"],
							] as const
						).map(([by, far, Icon, label, key]) => (
							<Button
								key={key}
								size="icon-sm"
								variant="ghost"
								disabled={marks[edge] === undefined}
								aria-label={`${name} ${label}`}
								title={`${name} ${label} (${key})`}
								onClick={() => onNudge({ edge, by, far })}
							>
								<Icon />
							</Button>
						))}
					</div>
				);
			})}
			<Button
				variant="ghost"
				size="xs"
				className="justify-self-end sm:col-span-2"
				disabled={marks.start === undefined && marks.end === undefined}
				aria-keyshortcuts="Escape"
				title="Clear both edges (Esc)"
				onClick={onReset}
			>
				Reset
				<KeyHint>Esc</KeyHint>
			</Button>
		</div>
	);
}

function EdgeTime({
	name,
	shown,
	onType,
}: {
	name: string;
	shown: string;
	onType: (text: string) => Promise<string>;
}) {
	const [text, setText] = useState<string>();
	const [refusal, setRefusal] = useState("");
	const refusalId = useId();
	if (text === undefined)
		return (
			<Button
				variant="ghost"
				size="xs"
				className="mr-1 ml-auto font-semibold text-sm tabular-nums"
				aria-label={`${name} at ${shown || "none"}; type a time`}
				title="Type a time, as 1:02:03.45, 2:03 or 123.4"
				onClick={() => {
					setRefusal("");
					setText(shown);
				}}
			>
				{shown || "–"}
			</Button>
		);
	return (
		<>
			<Input
				autoFocus
				aria-label={`${name} time`}
				aria-invalid={!!refusal}
				aria-describedby={refusal ? refusalId : undefined}
				className="mr-1 ml-auto h-7 w-24 px-2 text-sm tabular-nums md:text-sm"
				value={text}
				onFocus={(event) => event.currentTarget.select()}
				onChange={(event) => {
					setText(event.target.value);
					setRefusal("");
				}}
				onBlur={() => setText(undefined)}
				onKeyDown={async (event) => {
					if (event.key !== "Enter") return;
					event.preventDefault();
					const why = await onType(text);
					if (why) setRefusal(why);
					else setText(undefined);
				}}
			/>
			{refusal && (
				<p
					id={refusalId}
					role="alert"
					className="order-last basis-full pb-0.5 text-right text-destructive"
				>
					{refusal}
				</p>
			)}
		</>
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
	made,
	onSeek,
}: {
	path: string;
	time: number;
	duration: number;
	marks: Marks;
	made: Made[];
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
		<div
			role="slider"
			tabIndex={-1}
			aria-label="Seek"
			aria-valuemin={0}
			aria-valuemax={duration}
			aria-valuenow={time}
			aria-valuetext={clock(time, duration)}
			title="J and L jump 10 s; ← and → step a frame while paused, and 5 s while playing, until an edge is marked, which they then move"
			onPointerDown={(event) => {
				const bar = event.currentTarget.getBoundingClientRect();
				onSeek(((event.clientX - bar.left) / bar.width) * duration);
			}}
			onPointerMove={(event) => {
				if (!duration) return; // no spot has a time until the Source opens
				const bar = event.currentTarget.getBoundingClientRect();
				// By whole pixels, so a spot hovered over again has its
				// thumbnail cached.
				const x = Math.round(event.clientX - bar.left);
				setHover({
					time: (Math.min(Math.max(x, 0), bar.width) / bar.width) * duration,
					left: Math.min(Math.max(x, TIP_WIDTH / 2), bar.width - TIP_WIDTH / 2),
				});
			}}
			onPointerLeave={() => setHover(undefined)}
			className="relative h-10 cursor-pointer rounded-md bg-foreground/5 text-xs tabular-nums"
		>
			{made.map(({ key, start, end, save }) => (
				<div
					key={key}
					aria-hidden
					className={cn(
						"absolute bottom-0 h-1 rounded-full",
						save?.state === "failed"
							? "bg-destructive/70"
							: save
								? "bg-emerald-400/30"
								: "bg-emerald-400/70",
					)}
					style={{ left: along(start), width: along(end - start) }}
				/>
			))}
			{marks.start !== undefined && marks.end !== undefined && (
				<div
					aria-hidden
					className="absolute inset-y-0 bg-primary/30"
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
							className="absolute inset-y-0 w-[3px] -translate-x-1/2 bg-primary"
							style={{ left: along(at) }}
						/>
					)
				);
			})}
			<div
				aria-hidden
				className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-white shadow-[0_0_6px_white]"
				style={{ left: along(time) }}
			/>
			{hover && (
				<div
					aria-hidden
					className="pointer-events-none absolute bottom-full z-10 mb-2 -translate-x-1/2 overflow-hidden rounded-md border bg-black text-center text-white"
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
	);
}

// framesAround asks the server where a Moment of the Source at path can start
// and end over each of spans (media.go), in one list.
async function framesAround(
	path: string,
	spans: Span[],
	signal: AbortSignal,
): Promise<Frames> {
	const all = await Promise.all(
		spans.map(([at, to]) =>
			getJSON<Frames>(
				`/api/source/frames?${new URLSearchParams({ path, at: String(at), to: String(to) })}`,
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

export function formatLength(seconds: number) {
	const whole = Math.round(seconds);
	const [hours, minutes, rest] = [
		Math.floor(whole / 3600),
		Math.floor(whole / 60) % 60,
		whole % 60,
	];
	const two = (part: number) => String(part).padStart(2, "0");
	return hours
		? `${hours}:${two(minutes)}:${two(rest)}`
		: `${minutes}:${two(rest)}`;
}

function clock(seconds: number, duration: number, hundredths = false) {
	return new Date(seconds * 1000)
		.toISOString()
		.slice(duration < 3600 ? 14 : 11, hundredths ? 22 : 19);
}

function toggle(video: HTMLVideoElement | null) {
	if (video?.paused) video.play().catch(() => {});
	else video?.pause();
}
