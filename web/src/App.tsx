import { cn } from "cn";
import { Check, Clapperboard, ListOrdered, Play, Scissors } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Button } from "@/components/ui/button";
import { MomentMenu } from "./MomentMenu";
import { MomentPlayer } from "./MomentPlayer";
import { getJSON } from "./player";
import { anyOnItsWay, type Save, saveStatus } from "./saves";
import { Trimmer } from "./Trimmer";
import { useTabTitle } from "./title";

// Two screens, so a state switch instead of a router.
export function App() {
	const [screen, setScreen] = useState<"library" | "trimmer">("library");
	return screen === "library" ? (
		<Library onOpenTrimmer={() => setScreen("trimmer")} />
	) : (
		<Trimmer onBack={() => setScreen("library")} />
	);
}

type Moment = {
	title: string;
	length: number;
	sourceName?: string;
	created: string;
};

function Library({ onOpenTrimmer }: { onOpenTrimmer: () => void }) {
	useTabTitle("Library");
	const [moments, setMoments] = useState<Moment[]>();
	const [error, setError] = useState("");
	const [playing, setPlaying] = useState<{
		titles: string[];
		asQueue: boolean;
	}>();
	const [queue, setQueue] = useState<string[]>([]);
	const [selecting, setSelecting] = useState(false);
	const toggleQueued = (title: string) =>
		setQueue((titles) =>
			titles.includes(title)
				? titles.filter((other) => other !== title)
				: [...titles, title],
		);
	const play = (titles: string[], asQueue = false) =>
		flushSync(() => setPlaying({ titles, asQueue }));
	const [saves, setSaves] = useState<Save[]>([]); // in the order made
	const savesNow = useRef(saves);
	savesNow.current = saves;
	const pollsAsked = useRef(0);
	const newestApplied = useRef(0);
	const list = useCallback((signal?: AbortSignal) => {
		getJSON<Moment[]>("/api/moments", signal)
			.then(setMoments)
			.catch((error: Error) => {
				if (!signal?.aborted) setError(error.message);
			});
	}, []);
	const refresh = useCallback(async (signal?: AbortSignal) => {
		const asked = ++pollsAsked.current;
		const listed = await getJSON<Save[]>("/api/saves", signal).catch(
			() => undefined,
		);
		if (!listed) return;
		const done = savesNow.current.some(
			(save) => !listed.some((other) => other.id === save.id),
		);
		if (done) {
			// Unsignalled: the poll's abort, once no Save is left on its way, would cancel it.
			const library = await getJSON<Moment[]>("/api/moments").catch(
				() => undefined,
			);
			if (!library) return;
			setMoments(library);
		}
		if (asked < newestApplied.current) return;
		newestApplied.current = asked;
		setSaves(listed);
	}, []);
	const sendToSave = async (
		save: Save,
		action: string,
		method: string,
		suffix = "",
	) => {
		try {
			const response = await fetch(`/api/saves/${save.id}${suffix}`, {
				method,
			});
			if (response.ok) return true;
			if (response.status === 404 || response.status === 409) {
				refresh();
				return false;
			}
			throw new Error((await response.text()).trim());
		} catch (error) {
			setSaves((all) =>
				all.map((other) =>
					other.id === save.id
						? {
								...other,
								error: `${action} failed: ${(error as Error).message}`,
							}
						: other,
				),
			);
			return false;
		}
	};
	const retry = async (save: Save) => {
		if (await sendToSave(save, "Retry", "POST", "/retry")) refresh();
	};
	const dismiss = async (save: Save) => {
		if (await sendToSave(save, "Dismiss", "DELETE"))
			setSaves((all) => all.filter((other) => other.id !== save.id));
	};

	useEffect(() => {
		const abort = new AbortController();
		// Saves before Moments, or a Save done in between shows in neither.
		refresh(abort.signal).then(() => list(abort.signal));
		return () => abort.abort();
	}, [list, refresh]);
	useEffect(() => {
		if (moments)
			setQueue((titles) =>
				titles.filter((title) =>
					moments.some((moment) => moment.title === title),
				),
			);
	}, [moments]);
	const onItsWay = anyOnItsWay(saves);
	useEffect(() => {
		if (!onItsWay) return;
		const abort = new AbortController();
		const pollTimer = setInterval(() => refresh(abort.signal), 1000);
		return () => {
			clearInterval(pollTimer);
			abort.abort();
		};
	}, [onItsWay, refresh]);

	return (
		<>
			<header className="flex items-center justify-between gap-4 px-4 py-3">
				<h1 className="font-heading font-semibold text-lg">Library</h1>
				<span className="flex gap-2">
					{(selecting || !!moments?.length) && (
						<Button
							variant={selecting ? "default" : "outline"}
							onClick={() => setSelecting(!selecting)}
						>
							{selecting ? <Check /> : <ListOrdered />}
							{selecting ? "Done" : "Queue"}
						</Button>
					)}
					<Button variant="outline" onClick={onOpenTrimmer}>
						<Scissors />
						Trimmer
					</Button>
				</span>
			</header>
			{error ? (
				<p role="alert" className="px-4 text-destructive text-sm">
					{error}
				</p>
			) : moments?.length === 0 && saves.length === 0 ? (
				<EmptyLibrary />
			) : (
				<ul
					className={cn(
						"grid grid-cols-2 gap-x-3 gap-y-4 px-4 pb-6 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5",
						queue.length > 0 && "pb-24",
					)}
				>
					{saves.toReversed().map((save) => (
						<SaveTile
							key={`save ${save.id}`}
							save={save}
							onRetry={() => retry(save)}
							onDismiss={() => dismiss(save)}
						/>
					))}
					{moments?.map((moment) => {
						const place = queue.indexOf(moment.title) + 1;
						return (
							<li key={moment.title} className="flex min-w-0 flex-col gap-1.5">
								<button
									type="button"
									aria-label={`${selecting ? "Pick" : "Play"} ${moment.title}`}
									aria-pressed={selecting ? place > 0 : undefined}
									onClick={() =>
										selecting
											? toggleQueued(moment.title)
											: play([moment.title])
									}
									className={cn(
										"relative aspect-video overflow-hidden rounded-lg bg-black outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
										selecting && place > 0 && "ring-3 ring-primary",
									)}
								>
									<img
										src={`/api/moments/${encodeURIComponent(moment.title)}/poster`}
										alt=""
										loading="lazy"
										onError={(event) => {
											event.currentTarget.hidden = true;
										}}
										className="size-full object-contain"
									/>
									<span className="absolute right-1.5 bottom-1.5 rounded bg-black/70 px-1.5 py-0.5 font-medium text-white text-xs tabular-nums">
										{formatLength(moment.length)}
									</span>
									{(place > 0 || selecting) && (
										<span
											data-place
											className={cn(
												"absolute top-1.5 left-1.5 grid size-6 place-items-center rounded-full border-2 font-semibold text-xs tabular-nums",
												place > 0
													? "border-primary bg-primary text-primary-foreground"
													: "border-white/80 bg-black/40",
											)}
										>
											{place || ""}
										</span>
									)}
								</button>
								<div className="flex items-start gap-1">
									<div className="min-w-0 flex-1">
										<p className="line-clamp-2 break-words font-medium text-sm">
											{moment.title}
										</p>
										{moment.sourceName && (
											<p className="truncate text-muted-foreground text-xs">
												{moment.sourceName}
											</p>
										)}
									</div>
									<MomentMenu
										title={moment.title}
										queued={place > 0}
										onPlay={() => play([moment.title])}
										onToggleQueue={() => toggleQueued(moment.title)}
										onChanged={(renamedTo) => {
											if (renamedTo)
												setQueue((titles) =>
													titles.map((title) =>
														title === moment.title ? renamedTo : title,
													),
												);
											list();
										}}
									/>
								</div>
							</li>
						);
					})}
				</ul>
			)}
			{queue.length > 0 && (
				<div className="fixed inset-x-0 bottom-0 flex justify-center p-4">
					<div className="flex items-center gap-1 rounded-xl border bg-background p-1.5 shadow-lg">
						<Button onClick={() => play(queue, true)}>
							<Play />
							Play Queue ({queue.length})
						</Button>
						<Button variant="ghost" onClick={() => setQueue([])}>
							Clear
						</Button>
					</div>
				</div>
			)}
			{playing && (
				<MomentPlayer
					titles={playing.titles}
					onClose={() => setPlaying(undefined)}
					queueToggle={
						playing.asQueue
							? undefined
							: {
									queued: queue.includes(playing.titles[0]),
									onToggle: () => toggleQueued(playing.titles[0]),
								}
					}
				/>
			)}
		</>
	);
}

function SaveTile({
	save,
	onRetry,
	onDismiss,
}: {
	save: Save;
	onRetry: () => void;
	onDismiss: () => void;
}) {
	const failed = save.state === "failed";
	return (
		<li className="flex min-w-0 flex-col gap-1.5">
			<div className="relative grid aspect-video place-items-center rounded-lg bg-muted">
				<span
					aria-live="polite"
					className={`px-2 text-center font-medium text-sm tabular-nums ${failed ? "text-destructive" : "text-muted-foreground"}`}
				>
					{failed ? "Failed" : saveStatus(save)}
				</span>
				<span className="absolute right-1.5 bottom-1.5 rounded bg-black/70 px-1.5 py-0.5 font-medium text-white text-xs tabular-nums">
					{formatLength(save.end - save.start)}
				</span>
			</div>
			<div className="min-w-0">
				<p className="line-clamp-2 break-words font-medium text-sm">
					{save.title}
				</p>
				{save.sourceName && (
					<p className="truncate text-muted-foreground text-xs">
						{save.sourceName}
					</p>
				)}
				{failed && (
					<>
						<p className="mt-1 break-words text-destructive text-xs">
							{saveStatus(save)}
						</p>
						<span className="mt-1.5 flex gap-1">
							<Button variant="outline" size="xs" onClick={onRetry}>
								Retry
							</Button>
							<Button variant="ghost" size="xs" onClick={onDismiss}>
								Dismiss
							</Button>
						</span>
					</>
				)}
			</div>
		</li>
	);
}

function formatLength(seconds: number) {
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

function EmptyLibrary() {
	return (
		<main className="grid min-h-[70svh] place-items-center p-6 text-center">
			<div className="flex max-w-sm flex-col items-center gap-2">
				<Clapperboard className="mb-2 size-10 text-muted-foreground" />
				<h2 className="font-medium">No Moments yet</h2>
				<p className="text-balance text-muted-foreground text-sm">
					Mark a stretch of a video in the Trimmer and save it. It shows up
					here.
				</p>
			</div>
		</main>
	);
}
