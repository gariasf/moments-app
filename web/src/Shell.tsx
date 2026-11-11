import { cn } from "cn";
import {
	HardDrive,
	LayoutGrid,
	type LucideIcon,
	Menu,
	Play,
	Scissors,
	Upload,
	X,
} from "lucide-react";
import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import { flushSync } from "react-dom";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { type Address, readAddress, type Screen, urlOf } from "./address";
import { MomentPlayer } from "./MomentPlayer";
import { getJSON } from "./player";
import { uploadProgress } from "./upload";

export type LibraryMoment = {
	title: string;
	sourceName?: string;
	sourcePath?: string;
};

type LeaveGuard = (leave: () => void) => void;

type Uploading = {
	name: string;
	loadedBytes: number;
	totalBytes: number;
	elapsedMs: number;
};

const stallTimeoutMs = 15_000;

const ShellContext = createContext({
	openMenu: () => {},
	library: undefined as LibraryMoment[] | undefined,
	setLibrary: (_moments: LibraryMoment[]) => {},
	leaveGuard: { current: undefined } as { current?: LeaveGuard },
	queue: [] as string[],
	setQueue: (_update: (titles: string[]) => string[]) => {},
	toggleQueued: (_title: string) => {},
	play: (_titles: string[]) => {},
	uploading: undefined as Uploading | undefined,
	upload: (_file: File) => {},
	uploadError: "",
	setUploadError: (_error: string) => {},
	uploadCount: 0,
	missingTitle: undefined as string | undefined,
});

function goTo(address: Address, entry: "push" | "replace") {
	const url = urlOf(address);
	if (url === location.pathname + location.search) return;
	if (entry === "push") history.pushState({ pushed: true }, "", url);
	else history.replaceState(history.state, "", url);
}

export const useShell = () => useContext(ShellContext);

export function useLeaveGuard(guard?: LeaveGuard) {
	const { leaveGuard } = useShell();
	useEffect(() => {
		leaveGuard.current = guard;
		return () => {
			leaveGuard.current = undefined;
		};
	});
}

export function Shell({
	screen,
	onScreenChange,
	children,
}: {
	screen: Screen;
	onScreenChange: (screen: Screen, path?: string) => void;
	children: ReactNode;
}) {
	const [menuOpen, setMenuOpen] = useState(false);
	const [library, setLibrary] = useState<LibraryMoment[]>();
	const leaveGuard = useRef<LeaveGuard>(undefined);
	const [queue, setQueue] = useState<string[]>([]);
	const playCount = useRef(0);
	const [playing, setPlaying] = useState<{
		titles: string[];
		asQueue: boolean;
		key: number;
	}>();
	const {
		uploading,
		upload,
		cancelUpload,
		uploadError,
		setUploadError,
		uploadCount,
	} = useUpload();
	const toggleQueued = (title: string) =>
		setQueue((titles) =>
			titles.includes(title)
				? titles.filter((other) => other !== title)
				: [...titles, title],
		);
	const [missingTitle, setMissingTitle] = useState<string>();
	const navigationCount = useRef(0);
	const beginNavigation = () => {
		navigationCount.current++;
		setMenuOpen(false);
		setMissingTitle(undefined);
	};
	const play = (titles: string[], asQueue = false) => {
		beginNavigation();
		goTo({ screen, moment: titles[0] }, "push");
		for (const video of document.querySelectorAll("video")) video.pause();
		flushSync(() => setPlaying({ titles, asQueue, key: ++playCount.current }));
	};
	const close = () => {
		setPlaying(undefined);
		if (history.state?.pushed) history.back();
		else goTo({ screen }, "replace");
	};
	const openFromAddress = async (title: string) => {
		const asked = navigationCount.current;
		const moments = await getJSON<LibraryMoment[]>("/api/moments").catch(
			() => undefined,
		);
		if (asked !== navigationCount.current) return;
		if (moments && !moments.some((moment) => moment.title === title)) {
			const showLibrary = () => {
				goTo({ screen: "library" }, "replace");
				onScreenChange("library");
				setMissingTitle(title);
			};
			if (!leaveGuard.current) return showLibrary();
			goTo({ screen: "trimmer" }, "replace");
			leaveGuard.current(showLibrary);
		} else
			setPlaying({ titles: [title], asQueue: false, key: ++playCount.current });
	};
	const latestOpenFromAddress = useRef(openFromAddress);
	latestOpenFromAddress.current = openFromAddress;
	useEffect(() => {
		const { moment } = readAddress(location.search);
		if (moment) latestOpenFromAddress.current(moment);
	}, []);
	useEffect(() => {
		const showAddress = () => {
			const address = readAddress(location.search);
			beginNavigation();
			const go = () => {
				onScreenChange(address.screen);
				setPlaying(undefined);
				if (address.moment) openFromAddress(address.moment);
			};
			if (address.screen === screen || !leaveGuard.current) return go();
			setPlaying(undefined);
			goTo({ screen }, "push");
			leaveGuard.current(() => {
				goTo(address, "push");
				go();
			});
		};
		addEventListener("popstate", showAddress);
		return () => removeEventListener("popstate", showAddress);
	});
	const sidebar = (
		<Sidebar
			screen={playing ? undefined : screen}
			momentCount={library?.length}
			queue={queue}
			onRemove={(title) =>
				setQueue((titles) => titles.filter((other) => other !== title))
			}
			onClear={() => setQueue([])}
			onPlayQueue={() => play(queue, true)}
			uploading={uploading}
			onCancelUpload={cancelUpload}
			onScreenChange={(nextScreen, path) => {
				beginNavigation();
				setPlaying(undefined);
				const go = () => {
					goTo({ screen: nextScreen }, "push");
					onScreenChange(nextScreen, path);
				};
				if (nextScreen === screen || !leaveGuard.current) return go();
				goTo({ screen }, "push");
				leaveGuard.current(go);
			}}
		/>
	);
	return (
		<ShellContext
			value={{
				openMenu: () => setMenuOpen(true),
				library,
				setLibrary,
				leaveGuard,
				queue,
				setQueue,
				toggleQueued,
				play,
				uploading,
				upload,
				uploadError,
				setUploadError,
				uploadCount,
				missingTitle,
			}}
		>
			<div className="flex min-h-svh">
				<aside className="sticky top-0 hidden h-svh w-60 shrink-0 border-r bg-sidebar md:block">
					{sidebar}
				</aside>
				<Sheet open={menuOpen} onOpenChange={setMenuOpen}>
					<SheetContent side="left" className="bg-sidebar">
						<SheetTitle className="sr-only">Menu</SheetTitle>
						{sidebar}
					</SheetContent>
				</Sheet>
				<div
					className={cn("flex min-w-0 flex-1 flex-col", playing && "hidden")}
				>
					{children}
				</div>
				{playing && (
					<MomentPlayer
						key={playing.key}
						moments={playing.titles.map(
							(title) =>
								library?.find((moment) => moment.title === title) ?? { title },
						)}
						asQueue={playing.asQueue}
						onClose={close}
						onMove={(title) => goTo({ screen, moment: title }, "replace")}
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
			</div>
		</ShellContext>
	);
}

export function Toolbar({ children }: { children: ReactNode }) {
	const { openMenu } = useShell();
	return (
		<header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background px-4">
			<Button
				variant="ghost"
				size="icon"
				aria-label="Menu"
				className="-ml-1.5 md:hidden"
				onClick={openMenu}
			>
				<Menu />
			</Button>
			{children}
		</header>
	);
}

function Sidebar({
	screen,
	momentCount,
	queue,
	onRemove,
	onClear,
	onPlayQueue,
	uploading,
	onCancelUpload,
	onScreenChange,
}: {
	screen?: Screen;
	momentCount?: number;
	queue: string[];
	onRemove: (title: string) => void;
	onClear: () => void;
	onPlayQueue: () => void;
	uploading?: Uploading;
	onCancelUpload: () => void;
	onScreenChange: (screen: Screen, path?: string) => void;
}) {
	return (
		<div className="flex h-full flex-col gap-6 p-3">
			<span className="px-2 pt-2 font-heading text-lg">Moments</span>
			<nav className="flex flex-col gap-0.5 text-sm">
				<SideLink
					icon={LayoutGrid}
					label="Library"
					count={momentCount}
					current={screen === "library"}
					onClick={() => onScreenChange("library")}
				/>
				<SideLink
					icon={Scissors}
					label="Trimmer"
					current={screen === "trimmer"}
					onClick={() => onScreenChange("trimmer")}
				/>
			</nav>
			<nav aria-labelledby="sources-heading" className="flex flex-col text-sm">
				<h2 id="sources-heading" className={cn(sectionHeading, "px-2 pb-1")}>
					Sources
				</h2>
				<div className="flex flex-col gap-0.5">
					<SideLink
						icon={HardDrive}
						label="Home"
						onClick={() => onScreenChange("trimmer", "")}
					/>
					<SideLink
						icon={Upload}
						label="Uploads"
						onClick={() => onScreenChange("trimmer", "Uploads")}
					/>
				</div>
			</nav>
			<section
				aria-labelledby="queue-heading"
				className="flex min-h-0 flex-col"
			>
				<div className="flex h-6 items-center px-2 pb-1">
					<h2 id="queue-heading" className={sectionHeading}>
						Queue
					</h2>
					{queue.length > 0 && (
						<Button
							variant="ghost"
							size="xs"
							className="-mr-2 ml-auto text-muted-foreground"
							onClick={onClear}
						>
							Clear
						</Button>
					)}
				</div>
				{queue.length === 0 ? (
					<p className="px-2 text-muted-foreground text-xs">
						Add a Moment with the + on its tile. A Queue plays in order, then
						loops.
					</p>
				) : (
					<>
						<ol className="flex min-h-0 flex-col gap-0.5 overflow-y-auto">
							{queue.map((title, index) => (
								<li
									key={title}
									className="flex items-center gap-2 rounded-md py-1 pl-2 hover:bg-accent/50"
								>
									<span className="w-4 shrink-0 text-muted-foreground text-xs tabular-nums">
										{index + 1}
									</span>
									<span className="aspect-video w-10 shrink-0 overflow-hidden rounded-sm bg-black">
										<img
											src={`/api/moments/${encodeURIComponent(title)}/poster`}
											alt=""
											onError={(event) => {
												event.currentTarget.hidden = true;
											}}
											className="size-full object-contain"
										/>
									</span>
									<span
										title={title}
										className="min-w-0 flex-1 truncate text-xs"
									>
										{title}
									</span>
									<Button
										variant="ghost"
										size="icon-xs"
										aria-label={`Remove ${title} from the Queue`}
										className="text-muted-foreground"
										onClick={() => onRemove(title)}
									>
										<X />
									</Button>
								</li>
							))}
						</ol>
						<Button className="mt-2" onClick={onPlayQueue}>
							<Play />
							Play Queue
						</Button>
					</>
				)}
			</section>
			{uploading && (
				<SideUpload uploading={uploading} onCancel={onCancelUpload} />
			)}
		</div>
	);
}

function SideUpload({
	uploading,
	onCancel,
}: {
	uploading: Uploading;
	onCancel: () => void;
}) {
	const { percent, speed, timeLeft } = uploadProgress(uploading);
	return (
		<section
			aria-label="Upload"
			className="mt-auto shrink-0 rounded-lg bg-accent/50 p-3 ring-1 ring-border"
		>
			<div className="flex items-center gap-2 text-xs">
				<Upload className="size-3.5 shrink-0 text-primary" />
				<span
					title={uploading.name}
					className="min-w-0 flex-1 truncate font-semibold"
				>
					{uploading.name}
				</span>
				{uploading.loadedBytes < uploading.totalBytes && (
					<Button
						variant="ghost"
						size="icon-xs"
						aria-label={`Cancel the upload of ${uploading.name}`}
						className="-my-1 -mr-1.5 text-muted-foreground"
						onClick={onCancel}
					>
						<X />
					</Button>
				)}
			</div>
			<div
				role="progressbar"
				aria-label={`Upload of ${uploading.name}`}
				aria-valuenow={percent}
				className="mt-2 h-1 overflow-hidden rounded-full bg-foreground/10"
			>
				<div
					className="h-full bg-primary transition-[width] duration-200"
					style={{ width: `${percent}%` }}
				/>
			</div>
			<p className="mt-1.5 flex justify-between gap-2 text-muted-foreground text-xs tabular-nums">
				<span>
					{percent}%{speed && ` · ${speed}`}
				</span>
				<span>{timeLeft}</span>
			</p>
		</section>
	);
}

function useUpload() {
	const [uploading, setUploading] = useState<Uploading>();
	const [uploadError, setUploadError] = useState("");
	const [uploadCount, setUploadCount] = useState(0);
	const currentRequest = useRef<XMLHttpRequest>(undefined);

	function upload(file: File) {
		setUploadError("");
		setUploading({
			name: file.name,
			loadedBytes: 0,
			totalBytes: file.size,
			elapsedMs: 0,
		});
		const startedAt = performance.now();
		// XHR, since fetch reports no upload progress.
		const request = new XMLHttpRequest();
		currentRequest.current = request;
		request.open(
			"POST",
			`/api/uploads?${new URLSearchParams({ name: file.name })}`,
		);
		const cutOff = () => {
			setUploading(undefined);
			setUploadError(
				`The upload of ${file.name} was cut off. Upload it again.`,
			);
		};
		// A proxy on the way can drop the connection without the browser noticing.
		let stallTimer: ReturnType<typeof setTimeout> | undefined;
		const restartStallTimer = () => {
			clearTimeout(stallTimer);
			stallTimer = setTimeout(() => {
				request.abort();
				cutOff();
			}, stallTimeoutMs);
		};
		restartStallTimer();
		request.upload.onprogress = request.upload.onload = (event) => {
			restartStallTimer();
			setUploading({
				name: file.name,
				loadedBytes: event.loaded,
				totalBytes: file.size,
				elapsedMs: performance.now() - startedAt,
			});
		};
		request.onloadend = () => {
			clearTimeout(stallTimer);
			currentRequest.current = undefined;
		};
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
		};
		request.onerror = cutOff;
		request.send(file);
	}

	function cancelUpload() {
		currentRequest.current?.abort();
		setUploading(undefined);
	}

	return {
		uploading,
		upload,
		cancelUpload,
		uploadError,
		setUploadError,
		uploadCount,
	};
}

const sectionHeading =
	"font-semibold text-muted-foreground text-xs uppercase tracking-wider";

function SideLink({
	icon: Icon,
	label,
	count,
	current,
	onClick,
}: {
	icon: LucideIcon;
	label: string;
	count?: number;
	current?: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			aria-current={current ? "page" : undefined}
			onClick={onClick}
			className={cn(
				"flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left font-semibold outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
				current
					? "bg-accent text-accent-foreground"
					: "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
			)}
		>
			<Icon className={cn("size-4", current && "text-primary")} />
			<span className="flex-1">{label}</span>
			{count !== undefined && (
				<span className="font-normal text-muted-foreground text-xs tabular-nums">
					{count}
				</span>
			)}
		</button>
	);
}
