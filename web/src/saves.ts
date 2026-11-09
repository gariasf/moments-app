// A Save as the server lists it until it's done (saves.go).
export type Save = {
	id: number; // below 0 for one the server refused
	path: string;
	start: number;
	end: number;
	title: string;
	sourceName?: string;
	state: "waiting" | "saving" | "failed";
	error?: string;
	percent?: number;
	answered?: number; // when the server took it, by performance.now()
	sent?: string; // the request of one the server refused, sent again on Retry
};

export function saveStatus(save: Save) {
	if (save.state === "failed")
		return save.sent ? `Save failed: ${save.error}` : save.error;
	return save.state === "saving" ? `Saving ${save.percent ?? 0}%` : "Waiting";
}

export function anyOnItsWay(saves: Save[]) {
	return saves.some(
		(save) => save.state === "waiting" || save.state === "saving",
	);
}
