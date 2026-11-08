import { Clapperboard, Scissors } from "lucide-react";
import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { Button } from "@/components/ui/button";
import { MomentPlayer } from "./MomentPlayer";
import { getJSON } from "./player";
import { Trimmer } from "./Trimmer";

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
	const [moments, setMoments] = useState<Moment[]>();
	const [error, setError] = useState("");
	const [playing, setPlaying] = useState<string>();

	useEffect(() => {
		const abort = new AbortController();
		getJSON<Moment[]>("/api/moments", abort.signal)
			.then(setMoments)
			.catch((error: Error) => {
				if (!abort.signal.aborted) setError(error.message);
			});
		return () => abort.abort();
	}, []);

	return (
		<>
			<header className="flex items-center justify-between gap-4 px-4 py-3">
				<h1 className="font-heading font-semibold text-lg">Library</h1>
				<Button variant="outline" onClick={onOpenTrimmer}>
					<Scissors />
					Trimmer
				</Button>
			</header>
			{error ? (
				<p role="alert" className="px-4 text-destructive text-sm">
					{error}
				</p>
			) : moments?.length === 0 ? (
				<EmptyLibrary />
			) : (
				<ul className="grid grid-cols-2 gap-x-3 gap-y-4 px-4 pb-6 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
					{moments?.map((moment) => (
						<li key={moment.title} className="flex min-w-0 flex-col gap-1.5">
							<button
								type="button"
								aria-label={`Play ${moment.title}`}
								onClick={() => flushSync(() => setPlaying(moment.title))}
								className="relative aspect-video overflow-hidden rounded-lg bg-black outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
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
							<div className="min-w-0">
								<p className="line-clamp-2 break-words font-medium text-sm">
									{moment.title}
								</p>
								{moment.sourceName && (
									<p className="truncate text-muted-foreground text-xs">
										{moment.sourceName}
									</p>
								)}
							</div>
						</li>
					))}
				</ul>
			)}
			{playing && (
				<MomentPlayer title={playing} onClose={() => setPlaying(undefined)} />
			)}
		</>
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
