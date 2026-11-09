import {
	Download,
	Ellipsis,
	ListMinus,
	ListPlus,
	Pencil,
	Play,
	Trash2,
} from "lucide-react";
import { useState } from "react";
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";

async function send(url: string, init: RequestInit) {
	const response = await fetch(url, init);
	if (!response.ok) throw new Error((await response.text()).trim());
	return response;
}

export function MomentMenu({
	title,
	queued,
	onPlay,
	onToggleQueue,
	onChanged,
}: {
	title: string;
	queued: boolean;
	onPlay: () => void;
	onToggleQueue: () => void;
	onChanged: (renamedTo?: string) => void;
}) {
	const [dialog, setDialog] = useState<"rename" | "delete">();
	const [problem, setProblem] = useState("");
	const [busy, setBusy] = useState(false);
	const momentUrl = `/api/moments/${encodeURIComponent(title)}`;

	async function change(init: RequestInit) {
		setBusy(true);
		setProblem("");
		try {
			const response = await send(momentUrl, init);
			setDialog(undefined);
			onChanged(
				init.method === "PATCH" ? (await response.json()).title : undefined,
			);
		} catch (error) {
			setProblem((error as Error).message);
		} finally {
			setBusy(false);
		}
	}

	const showDialog = (shown: "rename" | "delete") => {
		setProblem("");
		setDialog(shown);
	};

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label={`More for ${title}`}
							className="-mt-1 -mr-1.5 text-muted-foreground"
						/>
					}
				>
					<Ellipsis />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-auto">
					<DropdownMenuItem onClick={onPlay}>
						<Play />
						Play
					</DropdownMenuItem>
					<DropdownMenuItem onClick={onToggleQueue}>
						{queued ? <ListMinus /> : <ListPlus />}
						{queued ? "Remove from Queue" : "Add to Queue"}
					</DropdownMenuItem>
					<DropdownMenuItem onClick={() => showDialog("rename")}>
						<Pencil />
						Rename
					</DropdownMenuItem>
					<DropdownMenuItem
						render={<a href={`${momentUrl}/file?download`} download />}
					>
						<Download />
						Download
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem
						variant="destructive"
						onClick={() => showDialog("delete")}
					>
						<Trash2 />
						Delete
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>

			<Dialog
				open={dialog === "rename"}
				onOpenChange={(isOpen) => !isOpen && setDialog(undefined)}
			>
				<DialogContent>
					<form
						className="grid gap-4"
						onSubmit={(event) => {
							event.preventDefault();
							const asked = new FormData(event.currentTarget).get("title");
							change({
								method: "PATCH",
								headers: { "Content-Type": "application/json" },
								body: JSON.stringify({ title: asked }),
							});
						}}
					>
						<DialogHeader>
							<DialogTitle>Rename Moment</DialogTitle>
						</DialogHeader>
						<Input
							name="title"
							defaultValue={title}
							aria-label="Title"
							autoFocus
							onFocus={(event) => event.currentTarget.select()}
						/>
						{problem && (
							<p role="alert" className="text-destructive text-sm">
								{problem}
							</p>
						)}
						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								onClick={() => setDialog(undefined)}
							>
								Cancel
							</Button>
							<Button type="submit" disabled={busy}>
								Rename
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>

			<AlertDialog
				open={dialog === "delete"}
				onOpenChange={(isOpen) => !isOpen && setDialog(undefined)}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Delete this Moment?</AlertDialogTitle>
						<AlertDialogDescription>
							“{title}” is deleted from Home/Moments. This can't be undone.
						</AlertDialogDescription>
					</AlertDialogHeader>
					{problem && (
						<p role="alert" className="text-destructive text-sm">
							{problem}
						</p>
					)}
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<Button
							variant="destructive"
							disabled={busy}
							onClick={() => change({ method: "DELETE" })}
						>
							Delete
						</Button>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
