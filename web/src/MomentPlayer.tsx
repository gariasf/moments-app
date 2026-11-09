import { cn } from "cn";
import {
	ListMinus,
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
import { useTabTitle } from "./title";

type IPhoneVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void };

// Mount it inside flushSync from the tap that opens it: play() must run within that tap for sound.
export function MomentPlayer({
	titles,
	onClose,
	queueToggle,
}: {
	titles: string[];
	onClose: () => void;
	queueToggle?: { queued: boolean; onToggle: () => void };
}) {
	const stage = useRef<HTMLDivElement>(null);
	const video = useRef<IPhoneVideo>(null);
	const [index, setIndex] = useState(0);
	const [startedIndex, setStartedIndex] = useState<number>();
	const [muted, setMuted] = useState(false);
	const [fullScreen, setFullScreen] = useState(false);
	const [problem, setProblem] = useState<{ index: number; message: string }>();
	const title = titles[index];
	const inQueue = !queueToggle;
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
			setFullScreen(document.fullscreenElement === stage.current);
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
		else if (document.fullscreenEnabled) stage.current?.requestFullscreen();
		else video.current?.webkitEnterFullscreen?.();
	}

	const indexAfter = (offset: number) =>
		(index + offset + titles.length) % titles.length;

	return (
		<div
			ref={stage}
			role="dialog"
			aria-modal="true"
			aria-label={title}
			className="fixed inset-0 z-50 bg-black text-white"
		>
			{/* biome-ignore lint/a11y/useMediaCaption: no subtitles in v1 (#17) */}
			<video
				ref={video}
				src={`/api/moments/${encodeURIComponent(title)}/file`}
				loop={titles.length === 1}
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
				className="size-full object-contain"
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
					"pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 px-6 pt-16 pb-8 font-heading font-semibold text-xl",
					startedIndex === index &&
						"animate-out fade-out fill-mode-forwards delay-2500 duration-1000",
				)}
			>
				{title}
			</p>
			{inQueue && (
				<div className="absolute top-3 left-3 flex items-center gap-1 rounded-xl bg-black/40 p-1 backdrop-blur-sm">
					<Button
						variant="ghost"
						size="icon-lg"
						aria-label="Previous"
						onClick={() => flushSync(() => setIndex(indexAfter(-1)))}
					>
						<SkipBack />
					</Button>
					<span className="px-1 font-medium text-sm tabular-nums">
						{index + 1} / {titles.length}
					</span>
					<Button
						variant="ghost"
						size="icon-lg"
						aria-label="Next"
						onClick={() => flushSync(() => setIndex(indexAfter(1)))}
					>
						<SkipForward />
					</Button>
				</div>
			)}
			<div className="absolute top-3 right-3 flex gap-1 rounded-xl bg-black/40 p-1 backdrop-blur-sm">
				{queueToggle && (
					<Button
						variant="ghost"
						size="icon-lg"
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
					size="icon-lg"
					aria-label={muted ? "Unmute" : "Mute"}
					onClick={() => {
						if (video.current) video.current.muted = !video.current.muted;
					}}
				>
					{muted ? <VolumeX /> : <Volume2 />}
				</Button>
				<Button
					variant="ghost"
					size="icon-lg"
					aria-label={fullScreen ? "Exit full screen" : "Full screen"}
					onClick={toggleFullScreen}
				>
					{fullScreen ? <Minimize /> : <Maximize />}
				</Button>
				<Button
					variant="ghost"
					size="icon-lg"
					aria-label="Close"
					onClick={onClose}
				>
					<X />
				</Button>
			</div>
		</div>
	);
}
