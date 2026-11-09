import assert from "node:assert/strict";
import { test } from "node:test";
import { dropRefusal, uploadProgress } from "./upload.ts";

test("one video drops, whatever the case of its extension", () => {
	assert.equal(dropRefusal([{ name: "Pioneer One S02E07.mkv" }]), "");
	assert.equal(dropRefusal([{ name: "IMG_0042.MOV" }]), "");
});

test("a file the upload doesn't take is refused by name", () => {
	assert.equal(
		dropRefusal([{ name: "notes.txt" }]),
		"notes.txt isn't a video Moments can upload.",
	);
	assert.equal(
		dropRefusal([{ name: "Season 2" }]),
		"Season 2 isn't a video Moments can upload.",
	);
});

test("several files at once are refused", () => {
	assert.equal(
		dropRefusal([{ name: "a.mp4" }, { name: "b.mp4" }]),
		"Drop one video at a time.",
	);
});

test("a drop while an upload runs is refused", () => {
	assert.equal(
		dropRefusal([{ name: "b.mp4" }], "a.mp4"),
		"Wait for the upload of a.mp4 to finish.",
	);
});

test("an upload under way shows its share, its speed and the time left", () => {
	assert.deepEqual(
		uploadProgress({
			loadedBytes: 50_000_000,
			totalBytes: 200_000_000,
			elapsedMs: 10_000,
		}),
		{ percent: 25, speed: "5 MB/s", timeLeft: "30 s left" },
	);
});

test("a long wait is told in minutes", () => {
	assert.equal(
		uploadProgress({
			loadedBytes: 1_000_000,
			totalBytes: 4_000_000_000,
			elapsedMs: 1_000,
		}).timeLeft,
		"67 min left",
	);
	assert.equal(
		uploadProgress({
			loadedBytes: 1_000_000,
			totalBytes: 92_000_000,
			elapsedMs: 1_000,
		}).timeLeft,
		"2 min left",
	);
});

test("before any bytes have gone, the upload is starting", () => {
	assert.deepEqual(
		uploadProgress({ loadedBytes: 0, totalBytes: 200_000_000, elapsedMs: 0 }),
		{ percent: 0, speed: "", timeLeft: "starting" },
	);
	assert.deepEqual(
		uploadProgress({ loadedBytes: 0, totalBytes: 0, elapsedMs: 300 }),
		{
			percent: 0,
			speed: "",
			timeLeft: "starting",
		},
	);
});

test("once every byte has gone, the upload is finishing", () => {
	assert.deepEqual(
		uploadProgress({
			loadedBytes: 200_000_000,
			totalBytes: 200_000_000,
			elapsedMs: 40_000,
		}),
		{ percent: 100, speed: "5 MB/s", timeLeft: "finishing" },
	);
});
