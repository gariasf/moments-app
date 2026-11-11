import { cn } from "cn";
import { Clapperboard, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { readAddress, type Screen } from "./address";
import { MomentMenu } from "./MomentMenu";
import { getJSON } from "./player";
import { Shell, Toolbar, useShell } from "./Shell";
import type { Place } from "./SourceBrowser";
import { anyOnItsWay, type Save } from "./saves";
import { formatLength, Trimmer } from "./Trimmer";
import { useTabTitle } from "./title";

export function App() {
	const [screen, setScreen] = useState<Screen>(
		() => readAddress(location.search).screen,
	);
	const [place, setPlace] = useState<Place>({ path: "" });
	return (
		<Shell
			screen={screen}
			onScreenChange={(nextScreen, path) => {
				setScreen(nextScreen);
				if (path !== undefined) setPlace({ path });
			}}
		>
			{screen === "library" ? <Library /> : <Trimmer place={place} />}
		</Shell>
	);
}

type Moment = {
	title: string;
	length: number;
	sourceName?: string;
	created: string;
};

function Library() {
	const { setLibrary, queue, setQueue, toggleQueued, play, missingTitle } =
		useShell();
	useTabTitle("Library");
	const [moments, setMoments] = useState<Moment[]>();
	const [error, setError] = useState("");
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
		if (moments) setLibrary(moments);
	}, [moments, setLibrary]);
	useEffect(() => {
		if (moments)
			setQueue((titles) =>
				titles.filter((title) =>
					moments.some((moment) => moment.title === title),
				),
			);
	}, [moments, setQueue]);
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
			<Toolbar>
				<h1 className="font-heading text-lg">Library</h1>
				<span className="text-muted-foreground text-sm">Newest first</span>
			</Toolbar>
			{missingTitle && (
				<p
					role="status"
					className="mx-4 mt-4 rounded-md bg-muted px-3 py-2 text-sm md:mx-5"
				>
					{missingTitle} isn't in the Library. It may have been renamed or
					deleted in Files.
				</p>
			)}
			{error ? (
				<p role="alert" className="p-4 text-destructive text-sm">
					{error}
				</p>
			) : moments?.length === 0 && saves.length === 0 ? (
				<EmptyLibrary />
			) : (
				<ul className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-x-4 gap-y-5 p-4 pb-6 md:p-5">
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
							<li
								key={moment.title}
								className="group relative flex min-w-0 flex-col gap-1.5"
							>
								<button
									type="button"
									aria-label={`Play ${moment.title}`}
									onClick={() => play([moment.title])}
									className={cn(
										"relative aspect-video overflow-hidden rounded-lg bg-black outline-none ring-1 ring-foreground/5 focus-visible:ring-3 focus-visible:ring-ring/50",
										place > 0 && "ring-2 ring-primary",
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
								</button>
								<button
									type="button"
									aria-label={
										place > 0
											? `Remove ${moment.title} from the Queue, place ${place}`
											: `Add ${moment.title} to the Queue`
									}
									onClick={() => toggleQueued(moment.title)}
									className={cn(
										"absolute top-1.5 right-1.5 grid size-7 place-items-center rounded-md font-semibold text-xs tabular-nums outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
										place > 0
											? "bg-primary text-primary-foreground"
											: "bg-black/70 text-white opacity-0 hover:bg-black/90 focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100",
									)}
								>
									{place || <Plus className="size-4" />}
								</button>
								<div className="flex items-start gap-1">
									<div className="min-w-0 flex-1">
										<p
											title={moment.title}
											className="truncate font-semibold text-sm"
										>
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
			<div className="relative aspect-video overflow-hidden rounded-lg bg-black ring-1 ring-foreground/5">
				<img
					src={`/api/source/thumbnail?${new URLSearchParams({ path: save.path, at: save.start.toFixed(3) })}`}
					alt=""
					onError={(event) => {
						event.currentTarget.hidden = true;
					}}
					className="size-full object-contain opacity-25 grayscale"
				/>
				<span
					aria-live="polite"
					className="absolute inset-0 grid place-items-center font-semibold text-xs tabular-nums"
				>
					{failed ? (
						<span className="rounded-md bg-destructive/15 px-2 py-1 text-destructive">
							Save failed
						</span>
					) : save.state === "saving" ? (
						<span className="relative grid size-12 place-items-center">
							<svg
								viewBox="0 0 36 36"
								aria-hidden
								className="-rotate-90 absolute inset-0"
							>
								<circle
									cx="18"
									cy="18"
									r="15"
									fill="none"
									strokeWidth="3"
									className="stroke-foreground/10"
								/>
								<circle
									cx="18"
									cy="18"
									r="15"
									fill="none"
									strokeWidth="3"
									strokeLinecap="round"
									pathLength={100}
									strokeDasharray={`${save.percent ?? 0} 100`}
									className="stroke-primary"
								/>
							</svg>
							{save.percent ?? 0}%
						</span>
					) : (
						<span className="text-muted-foreground">Waiting</span>
					)}
				</span>
				<span className="absolute right-1.5 bottom-1.5 rounded bg-black/70 px-1.5 py-0.5 font-medium text-white text-xs tabular-nums">
					{formatLength(save.end - save.start)}
				</span>
			</div>
			<div className="min-w-0">
				<p title={save.title} className="truncate font-semibold text-sm">
					{save.title}
				</p>
				{failed ? (
					<p className="flex items-baseline gap-3 text-xs">
						<Button
							variant="link"
							size="xs"
							onClick={onRetry}
							className="h-auto px-0 font-semibold"
						>
							Retry
						</Button>
						<Button
							variant="ghost"
							size="xs"
							onClick={onDismiss}
							className="h-auto px-0 font-normal text-muted-foreground hover:bg-transparent dark:hover:bg-transparent"
						>
							Dismiss
						</Button>
						<span
							title={save.error}
							className="min-w-0 truncate text-muted-foreground"
						>
							{save.error}
						</span>
					</p>
				) : (
					save.sourceName && (
						<p className="truncate text-muted-foreground text-xs">
							{save.sourceName}
						</p>
					)
				)}
			</div>
		</li>
	);
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
