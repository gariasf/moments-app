// The Moments check (#39): through a host run (umbrel/host-run.sh), a Moment saved from every Source
// in the test set decodes as a plain file in WebKit and in headless Chrome on the Mac, muted. A pass
// names the Sources by their traits only, so it can go in a PR; their paths stay out of the repo (#22).
// usage: node web/checks/moments.mjs <the URL umbrel/host-run.sh start prints>
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { onUmbrel, runPage } from "./harness.mjs";

const AT_SHARE = 0.45; // of the Source, where the Moment starts, past any opening's dark frames
const LENGTH_S = 3;
const SAVES_S = 300; // for every Save to end
const PREFIX = "moments-check-"; // of the Moments' titles, so the run's other Moments stay

const url = process.argv[2];
if (!url) {
	console.log(
		"usage: node web/checks/moments.mjs <the URL umbrel/host-run.sh start prints>",
	);
	process.exit(2);
}
const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
	encoding: "utf8",
}).trim();
const moments = `/home/umbrel/moments-check/${branch}/Moments`;
const api = async (path, init) => {
	const response = await fetch(new URL(`api/${path}`, url), init);
	if (!response.ok)
		throw new Error(`${response.status} ${(await response.text()).trim()}`);
	return response.status === 204 ? undefined : response.json();
};

onUmbrel(`rm -f ${moments}/${PREFIX}*.mp4`);
const problems = [];
const saved = [];
for (const line of onUmbrel(
	"cat /home/umbrel/moments-check/test-set.tsv",
).split("\n")) {
	const [path, traits] = line.split("\t");
	if (!traits || path.startsWith("#")) continue;
	try {
		const { duration } = await api(`source?${new URLSearchParams({ path })}`);
		const framesAt = (at) =>
			api(`source/frames?${new URLSearchParams({ path, at })}`);
		const start = Math.max(...(await framesAt(duration * AT_SHARE)).keyframes);
		const end = Math.max(...(await framesAt(start + LENGTH_S)).cleanEnds);
		const title = `${PREFIX}${saved.length + 1}`;
		await api("saves", {
			method: "POST",
			body: JSON.stringify({ path, start, end, title }),
		});
		saved.push({ traits, title, file: `${title}.mp4` });
	} catch (error) {
		problems.push(`${traits}: no Save: ${error.message}`);
	}
}

const titles = new Set(saved.map(({ title }) => title));
for (const deadline = Date.now() + SAVES_S * 1000; ; await sleep(1000)) {
	const ours = (await api("saves")).filter(({ title }) => titles.has(title));
	const failed = ours.filter(({ state }) => state === "failed");
	for (const { id, title, error } of failed) {
		const moment = saved.find((each) => each.title === title);
		moment.failed = error;
		problems.push(`${moment.traits}: the Save failed: ${error}`);
		await api(`saves/${id}`, { method: "DELETE" });
	}
	if (ours.length === failed.length) break;
	if (Date.now() > deadline) {
		problems.push(`Saves still on their way after ${SAVES_S} s`);
		break;
	}
}
const made = saved.filter(({ failed }) => !failed);
const files = made.map(({ file }) => file);

const local = mkdtempSync(join(tmpdir(), "moments-check-"));
try {
	if (made.length) {
		execFileSync("scp", [
			"-q",
			"-o",
			"BatchMode=yes",
			"-i",
			join(homedir(), ".ssh/umbrel_moments"),
			...files.map((file) => `umbrel@umbrel.local:${moments}/${file}`),
			local,
		]);
	}
	const carries = Object.fromEntries(
		onUmbrel(
			`cd ${moments} && for file in ${files.join(" ")}; do echo "$file $(ffprobe -v error -show_entries stream=codec_tag_string:stream_side_data=dv_profile -of csv=p=0 "$file" | tr '\\n' ' ')"; done`,
		)
			.split("\n")
			.filter(Boolean)
			.map((line) => line.split(/ (.*)/, 2)),
	);
	const engines = made.length
		? await runPage(
				`codec.html?colours=2&clips=${files.join(",")}`,
				local,
				undefined,
				30 + 10 * made.length,
			)
		: {};
	for (const [engine, { error, log }] of Object.entries(engines)) {
		if (error)
			problems.push(
				`${engine}: ${error}`,
				...log.slice(-10).map((line) => `  ${line}`),
			);
	}
	for (const { traits, file } of made) {
		const cells = Object.entries(engines).map(([engine, { results = [] }]) => {
			const seen = results.find((result) => result.file === file);
			if (seen?.verdict !== "plays")
				problems.push(
					`${engine}, ${traits}: ${seen ? `${seen.verdict}: ${seen.detail}` : "no result"}`,
				);
			return `${engine} ${seen?.verdict ?? "-"}`;
		});
		const carried = carries[file]?.trim() ?? "";
		if (/hev1/.test(carried))
			problems.push(`${traits}: the Moment's HEVC is hev1, want hvc1`);
		if (/Dolby Vision/.test(traits) && !/,8\b/.test(carried))
			problems.push(
				`${traits}: the Moment lost its Dolby Vision 8 configuration: ${carried}`,
			);
		console.log(`${traits}: ${carried}\n  ${cells.join(" · ")}`);
	}
} finally {
	rmSync(local, { recursive: true, force: true });
}
if (problems.length) {
	console.log(`FAIL\n${problems.join("\n")}`);
	process.exitCode = 1;
} else {
	console.log(
		`pass: a Moment from each of the ${made.length} test-set Sources decodes in both engines`,
	);
}
