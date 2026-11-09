import {
	ArrowLeft,
	ChevronLeft,
	ChevronRight,
	ChevronsLeft,
	ChevronsRight,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
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
	span,
} from "./marks";
import { type AudioTrack, getJSON, type Playback, playSource } from "./player";
import { formatSize, SourceBrowser, type Video } from "./SourceBrowser";
import { anyOnItsWay, type Save, saveStatus } from "./saves";
import { useTabTitle } from "./title";

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

// The Trimmer opens on its Source browser and plays the Source picked there.
export function Trimmer({ onBack }: { onBack: () => void }) {
	const [source, setSource] = useState<Video>();
	const [asking, setAsking] = useState(false);
	const leave = () => {
		setAsking(false);
		setSource(undefined);
	};
	const done = source?.deletable ? () => setAsking(true) : leave;
	useTabTitle(source?.sourceName ?? "Trimmer");
	return (
		<>
			<header className="flex items-center gap-2 px-4 py-3">
				<Button
					variant="ghost"
					className="-ml-2.5"
					onClick={source ? done : onBack}
				>
					<ArrowLeft />
					{source ? "Done" : "Library"}
				</Button>
				<h1 className="truncate font-heading font-semibold text-lg">
					{source?.sourceName ?? "Trimmer"}
				</h1>
			</header>
			<main className="mx-auto w-full max-w-5xl px-4 pb-6">
				{source && (
					<Player
						key={source.path}
						{...source}
						asking={asking}
						onStay={() => setAsking(false)}
						onLeave={leave}
					/>
				)}
				{/* Kept while a Source plays, so going back finds the same folder or
				search. */}
				<div hidden={!!source} className="mx-auto max-w-3xl">
					<SourceBrowser onOpen={setSource} shown={!source} />
				</div>
			</main>
		</>
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
	const video = useRef<HTMLVideoElement>(null);
	const playback = useRef<Playback>(null);
	const [problem, setProblem] = useState("");
	const [time, setTime] = useState(0);
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
			if (!v || !p || modified) return;
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
			nudging.current = saving.current = undefined;
			removeEventListener("keydown", onKey, true);
		};
	}, [path, change]);
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
					made={made}
					onSeek={(to) => {
						playback.current?.seek(to);
						change((m) => seek(m, to));
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
			<div hidden={!!problem}>
				<Nudges marks={marks} onNudge={(n) => nudging.current?.(n)} />
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
						(marks.start === undefined ? "" : prefill(sourceName, marks.start))
					}
					onChange={(e) => setTitle(e.target.value)}
				/>
				<Button
					type="submit"
					disabled={
						marks.start === undefined || marks.end === undefined || taken(marks)
					}
				>
					Save
				</Button>
			</form>
			{made.length > 0 && (
				<h2 hidden={!!problem} className="font-medium text-sm">
					Made from this Source
				</h2>
			)}
			{/* Live, and there from the start, so a screen reader says how each
			Save goes. */}
			<ul
				hidden={!!problem}
				aria-label="Made from this Source"
				aria-live="polite"
				className="text-sm"
			>
				{made.map(({ key, title, marks: madeFrom, save, length }) => (
					<li key={key} className="flex flex-wrap items-center gap-x-2">
						<Button
							variant="ghost"
							size="xs"
							className="-ml-2 font-normal"
							disabled={!madeFrom}
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
						<span className="text-muted-foreground tabular-nums">
							{save ? saveStatus(save) : clock(length ?? 0, length ?? 0)}
						</span>
						{save?.state === "failed" && (
							<span className="flex gap-1">
								<Button variant="outline" size="xs" onClick={() => retry(save)}>
									Retry
								</Button>
								<Button variant="ghost" size="xs" onClick={() => dismiss(save)}>
									Dismiss
								</Button>
							</span>
						)}
					</li>
				))}
			</ul>
			<p hidden={!!problem} className="text-muted-foreground text-xs">
				Space or a click plays and pauses. J and L jump 10 s; ← and → step a
				frame while paused, and 5 s while playing. I and O mark the start and
				end, which then loop until you seek away; \ turns the loop off and on,
				and Esc clears the marks. Once an edge is marked, ← and → move it: the
				start a keyframe, the end to the next frame it can end on, and with ⇧,
				about {FAR.start} s and {FAR.end} s. Tab selects the other edge. Enter
				saves the marked Moment under its title, and playback carries on from
				its end.
			</p>
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

// Nudges has buttons that move each marked edge as ← and → do, and ⇧← and ⇧→
// (marks.ts), giving onNudge the nudge, and picks out the edge selected.
function Nudges({
	marks,
	onNudge,
}: {
	marks: Marks;
	onNudge: (nudge: Nudge) => void;
}) {
	return (
		<div className="flex flex-wrap gap-x-6 gap-y-1">
			{(["start", "end"] as const).map((edge) => {
				const name = edge === "start" ? "Start" : "End";
				const step = edge === "start" ? "a keyframe" : "a frame it can end on";
				const about = `about ${FAR[edge]} s`;
				const selected = marks.start !== undefined && marks.edge === edge;
				return (
					<div key={edge} className="flex items-center gap-0.5">
						<span
							className={`mr-1 w-9 text-sm ${selected ? "font-medium" : "text-muted-foreground"}`}
						>
							{name}
						</span>
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
				{made.map(({ key, start, end, save }) => (
					<div
						key={key}
						aria-hidden
						className={`absolute inset-y-0 ${save?.state === "failed" ? "bg-destructive/70" : save ? "bg-sky-500/30" : "bg-sky-500/70"}`}
						style={{ left: along(start), width: along(end - start) }}
					/>
				))}
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
