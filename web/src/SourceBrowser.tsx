import { cn } from "cn";
import { ChevronRight, Film, Folder, Search, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getJSON } from "./player";
import { type LibraryMoment, useShell } from "./Shell";
import { dropRefusal, formatSize, videoExtensions } from "./upload";

// What GET /api/sources answers (sources.go). Paths are relative to Home.
type Listing = {
	folders: { name: string; path: string }[];
	videos: Video[];
};
// sourceName is the Source's name, from its folders: Pioneer One S02E07.
export type Video = {
	name: string;
	path: string;
	size: number;
	sourceName: string;
	deletable?: boolean;
};

export type Place = { path: string };

// Opens on place again for each new Place object, even at the same path.
export function SourceBrowser({
	place,
	playing,
	onOpen,
}: {
	place: Place;
	playing?: string;
	onOpen: (video: Video) => void;
}) {
	const {
		library,
		setLibrary,
		uploading,
		upload,
		uploadError,
		setUploadError,
		uploadCount,
	} = useShell();
	const [path, setPath] = useState(place.path); // "" is Home
	const [query, setQuery] = useState("");
	const [placeAsked, setPlaceAsked] = useState(place);
	if (place !== placeAsked) {
		setPlaceAsked(place);
		setQuery("");
		setPath(place.path);
	}
	// A listing keeps the search it answers, "" for a folder, so the list never
	// shows one as the other while the next is on its way.
	const [listing, setListing] = useState<Listing & { search: string }>();
	const [error, setError] = useState("");
	const counts = new Map<string, number>(); // by path
	for (const { sourcePath = "" } of library ?? [])
		counts.set(sourcePath, (counts.get(sourcePath) ?? 0) + 1);
	const [dragging, setDragging] = useState(false);
	const picker = useRef<HTMLInputElement>(null);
	const trimmedQuery = query.trim();
	const inUploads = path === "Uploads";

	function goTo(place: string) {
		setQuery("");
		setPath(place);
	}
	const [uploadsSeen, setUploadsSeen] = useState(uploadCount);
	if (uploadCount !== uploadsSeen) {
		setUploadsSeen(uploadCount);
		goTo("Uploads");
	}

	useEffect(() => {
		const abort = new AbortController();
		getJSON<LibraryMoment[]>("/api/moments", abort.signal)
			.then(setLibrary)
			.catch(() => {});
		return () => abort.abort();
	}, [setLibrary]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: a new upload, or the Source playing closed and maybe deleted, lists again
	useEffect(() => {
		const abort = new AbortController();
		// A search waits for a pause in typing; a folder opens at once.
		const timer = setTimeout(
			async () => {
				try {
					const params = new URLSearchParams(
						trimmedQuery ? { q: trimmedQuery } : { path },
					);
					const response = await fetch(`/api/sources?${params}`, {
						signal: abort.signal,
					});
					if (!response.ok) throw new Error((await response.text()).trim());
					setListing({ ...(await response.json()), search: trimmedQuery });
					setError("");
				} catch (failure) {
					if (!abort.signal.aborted) setError((failure as Error).message);
				}
			},
			trimmedQuery ? 200 : 0,
		);
		return () => {
			clearTimeout(timer);
			abort.abort();
		};
	}, [path, trimmedQuery, uploadCount, !playing]);

	const crumbs = inUploads
		? [{ name: "Uploads", to: "Uploads" }]
		: [
				{ name: "Home", to: "" },
				...(path ? path.split("/") : []).map((name, i, names) => ({
					name,
					to: names.slice(0, i + 1).join("/"),
				})),
			];
	return (
		<section
			aria-label="Sources"
			className="relative flex h-full flex-col"
			onDragEnter={(event) => {
				if (event.dataTransfer.types.includes("Files")) setDragging(true);
			}}
		>
			{dragging && (
				<section
					aria-label="Drop a video"
					className="absolute inset-0 z-10 flex flex-col justify-end bg-primary/10 p-3 ring-2 ring-primary ring-inset"
					onDragOver={(event) => {
						event.preventDefault();
						event.dataTransfer.dropEffect = "copy";
					}}
					onDragLeave={() => setDragging(false)}
					onDrop={(event) => {
						event.preventDefault();
						setDragging(false);
						const files = Array.from(event.dataTransfer.files);
						const refusal = dropRefusal(files, uploading?.name);
						if (refusal) setUploadError(refusal);
						else upload(files[0]);
					}}
				>
					<p className="pointer-events-none rounded-md bg-primary px-3 py-2 text-center font-semibold text-primary-foreground text-sm">
						Drop to upload into Uploads
					</p>
				</section>
			)}
			<div className="flex flex-col gap-2 border-b p-3">
				<div className="relative">
					<Search className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 size-4 text-muted-foreground" />
					<Input
						type="search"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder="Search Home and Uploads"
						aria-label="Search videos in Home and Uploads"
						className="pl-8"
					/>
				</div>
				<div className="flex items-center gap-1">
					<nav aria-label="Folder" className="min-w-0 flex-1">
						<ol className="flex flex-wrap items-center text-muted-foreground text-xs">
							{crumbs.map(({ name, to }, index) => (
								<li key={to} className="flex min-w-0 items-center">
									{index > 0 && <ChevronRight className="size-3 shrink-0" />}
									{index === crumbs.length - 1 && !trimmedQuery ? (
										<span
											aria-current="page"
											className="truncate px-1 font-semibold text-foreground"
										>
											{name}
										</span>
									) : (
										<button
											type="button"
											onClick={() => goTo(to)}
											className="truncate rounded-sm px-1 outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
										>
											{name}
										</button>
									)}
								</li>
							))}
						</ol>
					</nav>
					<Button
						variant="ghost"
						size="xs"
						className="text-primary"
						disabled={!!uploading}
						onClick={() => picker.current?.click()}
					>
						<Upload />
						Upload
					</Button>
					<input
						ref={picker}
						type="file"
						accept={videoExtensions}
						hidden
						aria-label="Video to upload"
						onChange={(event) => {
							const file = event.target.files?.[0];
							event.target.value = "";
							if (file) upload(file);
						}}
					/>
				</div>
				{uploadError && (
					<p role="alert" className="text-destructive text-xs">
						{uploadError}
					</p>
				)}
			</div>
			{error ? (
				<p role="alert" className="p-3 text-destructive text-sm">
					{error}
				</p>
			) : (
				listing && (
					<ul className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto p-1.5 text-sm">
						{listing.folders.map((folder) => (
							<li key={folder.path}>
								<button
									type="button"
									onClick={() => goTo(folder.path)}
									className={rowClass}
								>
									<Folder className="size-4 shrink-0 text-muted-foreground" />
									<span className="truncate">{folder.name}</span>
								</button>
							</li>
						))}
						{listing.videos.map((video) => {
							const count = counts.get(video.path) ?? 0;
							const picked = video.path === playing;
							return (
								<li key={video.path}>
									<button
										type="button"
										title={video.path}
										aria-current={picked ? "true" : undefined}
										onClick={() => onOpen(video)}
										className={cn(
											rowClass,
											picked && "bg-primary/20 hover:bg-primary/25",
										)}
									>
										<Film className="size-4 shrink-0 text-muted-foreground" />
										<span className="min-w-0 flex-1 truncate">
											{video.sourceName}
										</span>
										{count > 0 && (
											<span
												title={`${count} ${count === 1 ? "Moment" : "Moments"} made from it`}
												className="rounded-sm bg-primary/20 px-1.5 font-semibold text-primary-foreground text-xs tabular-nums"
											>
												{count}
											</span>
										)}
										<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
											{formatSize(video.size)}
										</span>
									</button>
								</li>
							);
						})}
						{listing.folders.length + listing.videos.length === 0 && (
							<li className="px-2 py-1.5 text-muted-foreground">
								{listing.search
									? "No videos match."
									: inUploads
										? "No uploads yet."
										: "No folders or videos here."}
							</li>
						)}
					</ul>
				)
			)}
		</section>
	);
}

const rowClass =
	"flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none hover:bg-accent/50 focus-visible:ring-3 focus-visible:ring-ring/50";
