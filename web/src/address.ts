export type Screen = "library" | "trimmer";

export type Address = { screen: Screen; moment?: string };

export function urlOf({ screen, moment }: Address) {
	const query = new URLSearchParams();
	if (screen !== "library") query.set("screen", screen);
	if (moment !== undefined) query.set("moment", moment);
	const queryString = query.toString();
	return queryString ? `/?${queryString}` : "/";
}

export function readAddress(search: string): Address {
	const query = new URLSearchParams(search);
	const moment = query.get("moment");
	return {
		screen: query.get("screen") === "trimmer" ? "trimmer" : "library",
		...(moment ? { moment } : {}),
	};
}
