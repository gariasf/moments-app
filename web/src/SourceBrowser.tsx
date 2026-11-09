import { ChevronRight, Film, Folder, Search, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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

// What GET /api/mounts answers (main.go): how the server finds the folders
// the package mounts, "" being Home, and how each should be.
type Mount = {
	path: string;
	access: "read-only" | "writable" | "missing";
	want: "read-only" | "writable";
};

// The videos POST /api/uploads takes (sources.go).
const videoExtensions =
	".avi,.m2ts,.m4v,.mkv,.mov,.mp4,.mpeg,.mpg,.mts,.webm,.wmv";

// Two places, the folders in Home and the videos in them, and Uploads, or a
// search across both. Picking a video opens it with onOpen.
export function SourceBrowser({
	onOpen,
	shown,
}: {
	onOpen: (video: Video) => void;
	shown: boolean;
}) {
	const [path, setPath] = useState(""); // "" is Home
	const [query, setQuery] = useState("");
	// A listing keeps the search it answers, "" for a folder, so the list never
	// shows one as the other while the next is on its way.
	const [listing, setListing] = useState<Listing & { search: string }>();
	const [error, setError] = useState("");
	const [mounts, setMounts] = useState<Mount[]>([]);
	const [counts, setCounts] = useState(new Map<string, number>()); // by path
	const [uploading, setUploading] = useState<{
		name: string;
		loaded: number;
		total: number;
	}>();
	const [uploadError, setUploadError] = useState("");
	const [uploadCount, setUploadCount] = useState(0);
	const picker = useRef<HTMLInputElement>(null);
	const trimmedQuery = query.trim();
	const inUploads = path === "Uploads";

	function goTo(place: string) {
		setQuery("");
		setPath(place);
	}

	function upload(file: File) {
		setUploadError("");
		setUploading({ name: file.name, loaded: 0, total: file.size });
		// XHR, since fetch reports no upload progress.
		const request = new XMLHttpRequest();
		request.open(
			"POST",
			`/api/uploads?${new URLSearchParams({ name: file.name })}`,
		);
		request.upload.onprogress = (event) =>
			setUploading({ name: file.name, loaded: event.loaded, total: file.size });
		request.onload = () => {
			setUploading(undefined);
			if (request.status !== 201) {
				setUploadError(
					request.responseText.trim() ||
						`The upload of ${file.name} failed: ${request.status} ${request.statusText}`,
				);
				return;
			}
			setUploadCount((count) => count + 1);
			goTo("Uploads");
		};
		request.onerror = () => {
			setUploading(undefined);
			setUploadError(
				`The upload of ${file.name} was cut off. Upload it again.`,
			);
		};
		request.send(file);
	}

	useEffect(() => {
		if (!shown) return;
		const abort = new AbortController();
		fetch("/api/moments", { signal: abort.signal })
			.then((response) => response.json())
			.then((library: { sourcePath?: string }[]) => {
				const byPath = new Map<string, number>();
				for (const { sourcePath = "" } of library)
					byPath.set(sourcePath, (byPath.get(sourcePath) ?? 0) + 1);
				setCounts(byPath);
			})
			.catch(() => {});
		return () => abort.abort();
	}, [shown]);

	useEffect(() => {
		fetch("/api/mounts")
			.then((response) => response.json())
			.then(setMounts)
			.catch(() => {}); // the listing reports a server that can't be reached
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: a new upload lists Uploads again
	useEffect(() => {
		if (!shown) return;
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
	}, [path, trimmedQuery, shown, uploadCount]);

	const crumbs = path && !inUploads ? path.split("/") : [];
	return (
		<div className="flex flex-col gap-3">
			<div className="relative">
				<Search className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 size-4 text-muted-foreground" />
				<Input
					type="search"
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder="Search videos in Home and Uploads"
					aria-label="Search videos in Home and Uploads"
					className="pl-8"
				/>
			</div>
			<div className="flex flex-wrap items-center gap-1">
				{[
					["Home", ""],
					["Uploads", "Uploads"],
				].map(([name, place]) => {
					const here = !trimmedQuery && (place === "Uploads") === inUploads;
					return (
						<Button
							key={name}
							variant={here ? "secondary" : "ghost"}
							size="sm"
							aria-pressed={here}
							onClick={() => goTo(place)}
						>
							{name}
						</Button>
					);
				})}
				<Button
					variant="outline"
					size="sm"
					className="ml-auto"
					disabled={!!uploading}
					onClick={() => picker.current?.click()}
				>
					<Upload />
					Upload a video
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
			{uploading && (
				<p role="status" className="px-2.5 text-sm tabular-nums">
					Uploading {uploading.name} · {formatSize(uploading.total)} ·{" "}
					{Math.floor((100 * uploading.loaded) / (uploading.total || 1))}%
				</p>
			)}
			{uploadError && (
				<p role="alert" className="px-2.5 text-destructive text-sm">
					{uploadError}
				</p>
			)}
			{!trimmedQuery && crumbs.length > 0 && (
				<nav aria-label="Folder">
					<ol className="flex flex-wrap items-center text-sm">
						{crumbs.map((name, i) => {
							const to = crumbs.slice(0, i + 1).join("/");
							return (
								<li key={to} className="flex items-center">
									<ChevronRight className="size-3.5 text-muted-foreground" />
									{i < crumbs.length - 1 ? (
										<Button
											variant="ghost"
											size="sm"
											onClick={() => setPath(to)}
										>
											{name}
										</Button>
									) : (
										<span aria-current="page" className="px-2.5 font-medium">
											{name}
										</span>
									)}
								</li>
							);
						})}
					</ol>
				</nav>
			)}
			{error ? (
				<p role="alert" className="px-2.5 text-destructive text-sm">
					{error}
				</p>
			) : (
				listing && (
					<ul className="flex flex-col">
						{listing.folders.map((folder) => (
							<li key={folder.path}>
								<Button
									variant="ghost"
									className="h-9 w-full justify-start"
									onClick={() => setPath(folder.path)}
								>
									<Folder className="text-muted-foreground" />
									<span className="truncate">{folder.name}</span>
								</Button>
							</li>
						))}
						{listing.videos.map((video) => (
							<li key={video.path}>
								<Button
									variant="ghost"
									className="h-auto w-full justify-start py-2 text-left font-normal"
									onClick={() => onOpen(video)}
								>
									<Film className="text-muted-foreground" />
									<span className="min-w-0 flex-1">
										<span className="flex items-center gap-2">
											<span className="truncate">{video.name}</span>
											{video.deletable && (
												<span
													title="Done can delete this Source"
													className="shrink-0 rounded-sm border px-1.5 text-muted-foreground text-xs"
												>
													Deletable
												</span>
											)}
										</span>
										{listing.search && (
											<span className="block truncate text-muted-foreground text-xs">
												{video.path.slice(0, -video.name.length - 1) || "Home"}
											</span>
										)}
									</span>
									<span className="shrink-0 text-muted-foreground tabular-nums">
										{momentCount(counts.get(video.path))}
										{formatSize(video.size)}
									</span>
								</Button>
							</li>
						))}
						{listing.folders.length + listing.videos.length === 0 && (
							<li className="px-2.5 py-2 text-muted-foreground text-sm">
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
			<p className="px-2.5 text-muted-foreground text-xs">
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
	);
}

function momentCount(count = 0) {
	if (!count) return "";
	return `${count} ${count === 1 ? "Moment" : "Moments"} · `;
}

const units = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"];

// formatSize writes bytes in decimal units, as Finder does: 4.2 GB.
export function formatSize(bytes: number) {
	const unitIndex = Math.min(
		units.length - 1,
		Math.max(0, Math.floor(Math.log10(bytes) / 3)),
	);
	return new Intl.NumberFormat(undefined, {
		style: "unit",
		unit: units[unitIndex],
		unitDisplay: "short",
		maximumFractionDigits: 1,
	}).format(bytes / 1000 ** unitIndex);
}
