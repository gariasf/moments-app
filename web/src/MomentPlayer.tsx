import { cn } from "cn";
import {
	ListMinus,
	ListOrdered,
	ListPlus,
	Maximize,
	Minimize,
	SkipBack,
	SkipForward,
	Volume2,
	VolumeX,
	X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Button } from "@/components/ui/button";
import { type LibraryMoment, Toolbar } from "./Shell";
import { useTabTitle } from "./title";

type IPhoneVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void };

// Mount it inside flushSync from the tap that opens it: play() must run within that tap for sound.
export function MomentPlayer({
	moments,
	asQueue,
	onClose,
	queueToggle,
}: {
	moments: LibraryMoment[];
	asQueue: boolean;
	onClose: () => void;
	queueToggle?: { queued: boolean; onToggle: () => void };
}) {
	const player = useRef<HTMLDivElement>(null);
	const video = useRef<IPhoneVideo>(null);
	const [index, setIndex] = useState(0);
	const [startedIndex, setStartedIndex] = useState<number>();
	const [muted, setMuted] = useState(false);
	const [fullScreen, setFullScreen] = useState(false);
	const [problem, setProblem] = useState<{ index: number; message: string }>();
	const { title, sourceName } = moments[index];
	useTabTitle(title);

	useLayoutEffect(() => {
		const element = video.current;
		const refused = (error: Error) => {
			if (error.name !== "AbortError")
				setProblem({ index, message: error.message });
		};
		element?.play().catch((error: Error) => {
			if (error.name !== "NotAllowedError") return refused(error);
			element.muted = true;
			element.play().catch(refused);
		});
	}, [index]);

	useEffect(() => {
		const onFullScreenChange = () =>
			setFullScreen(document.fullscreenElement === player.current);
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !document.fullscreenElement) onClose();
		};
		document.addEventListener("fullscreenchange", onFullScreenChange);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("fullscreenchange", onFullScreenChange);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [onClose]);

	function toggleFullScreen() {
		if (document.fullscreenElement) document.exitFullscreen();
		else if (document.fullscreenEnabled) player.current?.requestFullscreen();
		else video.current?.webkitEnterFullscreen?.();
	}

	const indexAfter = (offset: number) =>
		(index + offset + moments.length) % moments.length;
	const playAt = (position: number) => flushSync(() => setIndex(position));

	return (
		<div
			ref={player}
			className="flex h-svh min-w-0 flex-1 flex-col bg-background"
		>
			<Toolbar>
				<div className="min-w-0 flex-1 leading-tight">
					<h1 title={title} className="truncate font-semibold">
						{title}
					</h1>
					{sourceName && (
						<p className="truncate text-muted-foreground text-xs">
							{sourceName}
						</p>
					)}
				</div>
				{asQueue && (
					<div className="flex items-center">
						<Button
							variant="ghost"
							size="icon"
							aria-label="Previous"
							onClick={() => playAt(indexAfter(-1))}
						>
							<SkipBack />
						</Button>
						<span className="px-1 font-medium text-sm tabular-nums">
							{index + 1} / {moments.length}
						</span>
						<Button
							variant="ghost"
							size="icon"
							aria-label="Next"
							onClick={() => playAt(indexAfter(1))}
						>
							<SkipForward />
						</Button>
					</div>
				)}
				{queueToggle && (
					<Button
						variant="ghost"
						size="icon"
						aria-label={
							queueToggle.queued ? "Remove from Queue" : "Add to Queue"
						}
						onClick={queueToggle.onToggle}
					>
						{queueToggle.queued ? <ListMinus /> : <ListPlus />}
					</Button>
				)}
				<Button
					variant="ghost"
					size="icon"
					aria-label={muted ? "Unmute" : "Mute"}
					onClick={() => {
						if (video.current) video.current.muted = !video.current.muted;
					}}
				>
					{muted ? <VolumeX /> : <Volume2 />}
				</Button>
				<Button
					variant="ghost"
					size="icon"
					aria-label={fullScreen ? "Exit full screen" : "Full screen"}
					onClick={toggleFullScreen}
				>
					{fullScreen ? <Minimize /> : <Maximize />}
				</Button>
				<Button
					variant="ghost"
					aria-label="Close"
					aria-keyshortcuts="Escape"
					className="text-muted-foreground max-sm:size-8 max-sm:px-0"
					onClick={onClose}
				>
					<X />
					<span className="max-sm:hidden">Close</span>
					<kbd className="rounded bg-foreground/10 px-1 font-sans text-[10px] max-sm:hidden pointer-coarse:hidden">
						Esc
					</kbd>
				</Button>
			</Toolbar>
			<div className="flex min-h-0 flex-1 flex-col md:flex-row">
				<div className="relative min-h-0 min-w-0 flex-1 bg-black text-white">
					{/* biome-ignore lint/a11y/useMediaCaption: no subtitles in v1 (#17) */}
					<video
						ref={video}
						src={`/api/moments/${encodeURIComponent(title)}/file`}
						loop={moments.length === 1}
						playsInline
						preload="auto"
						onPlaying={() => {
							setStartedIndex(index);
							setProblem(undefined);
						}}
						onEnded={() => setIndex(indexAfter(1))}
						onVolumeChange={(event) => setMuted(event.currentTarget.muted)}
						onError={(event) =>
							setProblem({
								index,
								message:
									event.currentTarget.error?.message ||
									"the browser can't play its file",
							})
						}
						className="absolute inset-0 size-full object-contain"
					/>
					{problem?.index === index && (
						<p
							role="alert"
							className="absolute inset-0 grid place-items-center p-6 text-center text-sm"
						>
							Can't play this Moment: {problem.message}
						</p>
					)}
					<p
						key={index}
						data-title
						className={cn(
							"pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 px-6 pt-16 pb-8 font-heading text-xl",
							startedIndex === index &&
								"animate-out fade-out fill-mode-forwards delay-2500 duration-1000",
						)}
					>
						{title}
					</p>
				</div>
				{asQueue && (
					<section
						aria-labelledby="playing-queue-heading"
						className="max-h-2/5 shrink-0 overflow-y-auto border-t p-3 md:max-h-none md:w-72 md:border-t-0 md:border-l"
					>
						<h2
							id="playing-queue-heading"
							className="flex items-center gap-2 px-1 pb-2 font-semibold text-muted-foreground text-xs uppercase tracking-wider"
						>
							<ListOrdered className="size-3.5" /> Queue · loops
						</h2>
						<ol className="flex flex-col gap-1">
							{moments.map((moment, position) => (
								<li key={moment.title}>
									<button
										type="button"
										aria-current={position === index ? "true" : undefined}
										onClick={() => playAt(position)}
										className={cn(
											"flex w-full items-center gap-2 rounded-md p-1.5 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
											position === index
												? "bg-primary/15 ring-1 ring-primary/50"
												: "hover:bg-accent/50",
										)}
									>
										<span className="w-4 shrink-0 text-muted-foreground text-xs tabular-nums">
											{position + 1}
										</span>
										<span className="aspect-video w-16 shrink-0 overflow-hidden rounded-sm bg-black">
											<img
												src={`/api/moments/${encodeURIComponent(moment.title)}/poster`}
												alt=""
												onError={(event) => {
													event.currentTarget.hidden = true;
												}}
												className="size-full object-contain"
											/>
										</span>
										<span className="min-w-0 flex-1">
											<span
												title={moment.title}
												className="block truncate font-semibold text-xs"
											>
												{moment.title}
											</span>
											{moment.sourceName && (
												<span className="block truncate text-muted-foreground text-xs">
													{moment.sourceName}
												</span>
											)}
										</span>
									</button>
								</li>
							))}
						</ol>
					</section>
				)}
			</div>
		</div>
	);
}
