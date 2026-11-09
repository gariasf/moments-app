// The videos POST /api/uploads takes (sources.go).
export const videoExtensions =
	".avi,.m2ts,.m4v,.mkv,.mov,.mp4,.mpeg,.mpg,.mts,.webm,.wmv";

export function dropRefusal(files: { name: string }[], uploadingName?: string) {
	if (uploadingName)
		return `Wait for the upload of ${uploadingName} to finish.`;
	if (files.length !== 1) return "Drop one video at a time.";
	const [{ name }] = files;
	const extension = name.slice(name.lastIndexOf(".")).toLowerCase();
	if (!videoExtensions.split(",").includes(extension))
		return `${name} isn't a video Moments can upload.`;
	return "";
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

export function uploadProgress({
	loadedBytes,
	totalBytes,
	elapsedMs,
}: {
	loadedBytes: number;
	totalBytes: number;
	elapsedMs: number;
}) {
	if (!loadedBytes || !elapsedMs)
		return { percent: 0, speed: "", timeLeft: "starting" };
	const bytesPerSecond = (1000 * loadedBytes) / elapsedMs;
	const speed = `${formatSize(bytesPerSecond)}/s`;
	if (loadedBytes >= totalBytes)
		return { percent: 100, speed, timeLeft: "finishing" };
	const secondsLeft = (totalBytes - loadedBytes) / bytesPerSecond;
	return {
		percent: Math.floor((100 * loadedBytes) / totalBytes),
		speed,
		timeLeft:
			secondsLeft > 90
				? `${Math.ceil(secondsLeft / 60)} min left`
				: `${Math.ceil(secondsLeft)} s left`,
	};
}
