import { ChevronRight, Film, Folder, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// What GET /api/sources answers (sources.go). Paths are relative to Home.
type Listing = {
	folders: { name: string; path: string }[];
	videos: Video[];
};
// sourceName is the Source's name, from its folders: Pioneer One S02E07.
type Video = { name: string; path: string; size: number; sourceName: string };

// What GET /api/mounts answers (main.go): how the server finds the folders
// the package mounts, "" being Home, and how each should be.
type Mount = {
	path: string;
	access: "read-only" | "writable" | "missing";
	want: "read-only" | "writable";
};

// The folders in Home and the videos in them, or a search across all of Home.
// Picking a video opens it with onOpen.
export function SourceBrowser({ onOpen }: { onOpen: (video: Video) => void }) {
	const [path, setPath] = useState(""); // "" is Home
	const [query, setQuery] = useState("");
	// A listing keeps the search it answers, "" for a folder, so the list never
	// shows one as the other while the next is on its way.
	const [listing, setListing] = useState<Listing & { q: string }>();
	const [error, setError] = useState("");
	const [mounts, setMounts] = useState<Mount[]>([]);
	const q = query.trim();

	useEffect(() => {
		fetch("/api/mounts")
			.then((res) => res.json())
			.then(setMounts)
			.catch(() => {}); // the listing reports a server that can't be reached
	}, []);

	useEffect(() => {
		const abort = new AbortController();
		// A search waits for a pause in typing; a folder opens at once.
		const timer = setTimeout(
			async () => {
				try {
					const params = new URLSearchParams(q ? { q } : { path });
					const res = await fetch(`/api/sources?${params}`, {
						signal: abort.signal,
					});
					if (!res.ok) throw new Error((await res.text()).trim());
					setListing({ ...(await res.json()), q });
					setError("");
				} catch (err) {
					if (!abort.signal.aborted) setError((err as Error).message);
				}
			},
			q ? 200 : 0,
		);
		return () => {
			clearTimeout(timer);
			abort.abort();
		};
	}, [path, q]);

	const crumbs = path ? path.split("/") : [];
	return (
		<div className="flex flex-col gap-3">
			<div className="relative">
				<Search className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 size-4 text-muted-foreground" />
				<Input
					type="search"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder="Search videos in Home"
					aria-label="Search videos in Home"
					className="pl-8"
				/>
			</div>
			{!q && (
				<nav aria-label="Folder">
					<ol className="flex flex-wrap items-center text-sm">
						{["Home", ...crumbs].map((name, i) => {
							const to = crumbs.slice(0, i).join("/");
							return (
								<li key={to} className="flex items-center">
									{i > 0 && (
										<ChevronRight className="size-3.5 text-muted-foreground" />
									)}
									{i < crumbs.length ? (
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
										<span className="block truncate">{video.name}</span>
										{listing.q && (
											<span className="block truncate text-muted-foreground text-xs">
												{video.path.slice(0, -video.name.length - 1) || "Home"}
											</span>
										)}
									</span>
									<span className="shrink-0 text-muted-foreground tabular-nums">
										{formatSize(video.size)}
									</span>
								</Button>
							</li>
						))}
						{listing.folders.length + listing.videos.length === 0 && (
							<li className="px-2.5 py-2 text-muted-foreground text-sm">
								{listing.q ? "No videos match." : "No folders or videos here."}
							</li>
						)}
					</ul>
				)
			)}
			<p className="px-2.5 text-muted-foreground text-xs">
				{mounts.map((m) => (
					<span
						key={m.path}
						className={m.access === m.want ? undefined : "text-destructive"}
					>
						{m.path || "Home"} is {m.access}
						{m.access !== m.want && `, and should be ${m.want}`}.{" "}
					</span>
				))}
			</p>
		</div>
	);
}

const units = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"];

// formatSize writes bytes in decimal units, as Finder does: 4.2 GB.
function formatSize(bytes: number) {
	const i = Math.min(
		units.length - 1,
		Math.max(0, Math.floor(Math.log10(bytes) / 3)),
	);
	return new Intl.NumberFormat(undefined, {
		style: "unit",
		unit: units[i],
		unitDisplay: "short",
		maximumFractionDigits: 1,
	}).format(bytes / 1000 ** i);
}
