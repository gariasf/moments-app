import { Clapperboard, Scissors } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
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

function Library({ onOpenTrimmer }: { onOpenTrimmer: () => void }) {
	return (
		<>
			<header className="flex items-center justify-between gap-4 px-4 py-3">
				<h1 className="font-heading font-semibold text-lg">Library</h1>
				<Button variant="outline" onClick={onOpenTrimmer}>
					<Scissors />
					Trimmer
				</Button>
			</header>
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
		</>
	);
}
