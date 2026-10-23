// The browser-check harness (#16): opens a check page from this folder in the system WebKit and in
// headless Chrome on the Mac, both muted, and returns what the page posts back to /results. It needs
// no packages: a short Swift program drives WebKit, and Node's own WebSocket drives Chrome.
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
	createReadStream,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { createServer } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const LIMIT_S = 60; // for a page to post its results, unless runPage is given another
const TYPES = {
	".html": "text/html; charset=utf-8",
	".mp4": "video/mp4",
	".m4a": "audio/mp4",
};

// Engines still open when this process exits, however it exits, are killed with it.
const running = new Set();
process.on("exit", () => {
	for (const engine of running) engine.kill();
});

/**
 * Opens `page`, a file in this folder with any query, in both engines at once. The files in
 * `media` are served under /media/, the UI's modules in web/src under /src/ as JavaScript, and
 * requests under /api/ go on to the Moments server at the URL `api`. Each engine gives what its
 * page posted (`{ results }` or `{ error }`) within `limitS` seconds, or an `error` saying why
 * nothing came, and a `log` of what the engine said.
 */
export async function runPage(page, media, api, limitS = LIMIT_S) {
	const posts = {
		webkit: Promise.withResolvers(),
		chrome: Promise.withResolvers(),
	};
	const server = createServer(async (req, res) => {
		const { pathname, searchParams } = new URL(req.url, "http://localhost");
		if (req.method === "POST" && pathname === "/results") {
			const body = [];
			for await (const chunk of req) body.push(chunk);
			posts[searchParams.get("engine")]?.resolve(
				JSON.parse(Buffer.concat(body)),
			);
			return res.writeHead(204).end();
		}
		if (api && pathname.startsWith("/api/"))
			return proxy(res, new URL(req.url, api));
		if (pathname.startsWith("/src/") && pathname.endsWith(".ts"))
			return serveModule(res, join(import.meta.dirname, "..", pathname));
		const inMedia = pathname.startsWith("/media/");
		const path = inMedia
			? join(media, pathname.slice(7))
			: join(import.meta.dirname, pathname);
		serve(req, res, path);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const url = `http://127.0.0.1:${server.address().port}/${page}${page.includes("?") ? "&" : "?"}engine=`;
	const tmp = mkdtempSync(join(tmpdir(), "moments-check-"));
	try {
		const [webkit, chrome] = await Promise.all([
			inWebKit(`${url}webkit`, posts.webkit.promise, tmp, limitS),
			inChrome(`${url}chrome`, posts.chrome.promise, tmp, limitS),
		]);
		return { webkit, chrome };
	} finally {
		server.close();
		server.closeAllConnections();
		rmSync(tmp, { recursive: true, force: true });
	}
}

// A file with single-range requests, which WebKit needs to play media.
function serve(req, res, path) {
	let size;
	try {
		const stat = statSync(path);
		if (!stat.isFile()) throw new Error("not a file");
		size = stat.size;
	} catch {
		return res.writeHead(404).end();
	}
	const headers = {
		"Content-Type": TYPES[extname(path)] ?? "application/octet-stream",
		"Cache-Control": "no-store",
	};
	const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
	let [start, end] = [0, size - 1];
	if (range && (range[1] || range[2])) {
		start = range[1] ? Number(range[1]) : Math.max(size - Number(range[2]), 0);
		end =
			range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
		if (start > end)
			return res.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
		headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
	}
	res.writeHead(headers["Content-Range"] ? 206 : 200, {
		...headers,
		"Content-Length": end - start + 1,
	});
	if (req.method === "HEAD") return res.end();
	createReadStream(path, { start, end }).pipe(res);
}

// The Moments server's answer at url, passed on as it streams. A page that reads slowly holds
// the server back, and one that closes closes it.
async function proxy(res, url) {
	const closed = new AbortController();
	res.on("close", () => closed.abort());
	try {
		const answer = await fetch(url, { signal: closed.signal });
		res.writeHead(answer.status, {
			"Content-Type": answer.headers.get("Content-Type") ?? "text/plain",
		});
		await pipeline(Readable.fromWeb(answer.body), res);
	} catch {
		res.destroy();
	}
}

// A TypeScript module of the UI as JavaScript, so a check page runs the UI's own code.
function serveModule(res, path) {
	let code;
	try {
		code = readFileSync(path, "utf8");
	} catch {
		return res.writeHead(404).end();
	}
	// Node warns that stripping types is experimental, which is no news to a check.
	const warn = process.emitWarning;
	process.emitWarning = () => {};
	try {
		code = stripTypeScriptTypes(code);
	} finally {
		process.emitWarning = warn;
	}
	res.writeHead(200, {
		"Content-Type": "text/javascript",
		"Cache-Control": "no-store",
	});
	res.end(code);
}

// WebKit in a small window that stays visible, floats, and never takes focus (wkrun.swift).
async function inWebKit(url, posted, tmp, limitS) {
	const wkrun = join(tmp, "wkrun");
	try {
		await promisify(execFile)("swiftc", [
			join(import.meta.dirname, "wkrun.swift"),
			"-o",
			wkrun,
		]);
	} catch (e) {
		return {
			error: "wkrun.swift didn't build",
			log: lines(e.stderr || e.message),
		};
	}
	const log = [];
	const webkit = launch(wkrun, [url, String(limitS + 10)]);
	webkit.stderr.on("data", (text) => log.push(...lines(text)));
	return outcome(webkit, posted, log, limitS);
}

// Headless Chrome, driven over its DevTools socket. Its log is what the page logged, since what
// Chrome itself prints is noise.
async function inChrome(url, posted, tmp, limitS) {
	const log = [];
	const chrome = launch(CHROME, [
		"--headless",
		"--mute-audio",
		"--remote-debugging-port=0",
		`--user-data-dir=${join(tmp, "chrome")}`,
	]);
	try {
		const port = await new Promise((resolve, reject) => {
			let said = "";
			chrome.stderr.on("data", (text) => {
				said += text;
				const listening = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(
					said,
				);
				if (listening) resolve(listening[1]);
			});
			chrome.exited.then(() =>
				reject(new Error("Chrome exited before DevTools listened")),
			);
			setTimeout(
				() => reject(new Error("Chrome's DevTools didn't listen in 30 s")),
				30_000,
			).unref();
		});
		const tab = await (
			await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
				method: "PUT",
			})
		).json();
		const send = await devtools(tab.webSocketDebuggerUrl, (event) => {
			const line = describe(event);
			if (line) log.push(line);
		});
		await send("Runtime.enable");
		await send("Log.enable");
		await send("Page.navigate", { url });
	} catch (e) {
		await stop(chrome);
		return { error: e.message, log };
	}
	return outcome(chrome, posted, log, limitS);
}

// A DevTools session on one tab: send(method, params) resolves with the answer; events go to onEvent.
async function devtools(socketUrl, onEvent) {
	const socket = new WebSocket(socketUrl);
	const answers = new Map();
	socket.addEventListener("message", ({ data }) => {
		const message = JSON.parse(data);
		if (message.id) answers.get(message.id)(message);
		else onEvent(message);
	});
	await once(socket, "open");
	let id = 0;
	return (method, params) =>
		new Promise((resolve) => {
			answers.set(++id, resolve);
			socket.send(JSON.stringify({ id, method, params }));
		});
}

function describe({ method, params }) {
	if (method === "Runtime.exceptionThrown") {
		return (
			params.exceptionDetails.exception?.description ??
			params.exceptionDetails.text
		);
	}
	if (method === "Runtime.consoleAPICalled") {
		return `console.${params.type}: ${params.args.map((arg) => arg.value ?? arg.description).join(" ")}`;
	}
	if (method === "Log.entryAdded")
		return `${params.entry.level}: ${params.entry.text} ${params.entry.url ?? ""}`;
}

function launch(command, args) {
	const engine = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
	engine.exited = once(engine, "exit");
	running.add(engine);
	engine.exited.then(() => running.delete(engine));
	engine.stderr.setEncoding("utf8");
	return engine;
}

// What the page posted, or why nothing came; the engine is stopped either way.
async function outcome(engine, posted, log, limitS) {
	const exited = engine.exited.then(([code]) => ({
		error: `exited with code ${code} before the page posted`,
	}));
	const late = sleep(
		limitS * 1000,
		{ error: `the page posted nothing in ${limitS} s` },
		{ ref: false },
	);
	try {
		return { ...(await Promise.race([posted, exited, late])), log };
	} finally {
		await stop(engine);
	}
}

async function stop(engine) {
	engine.kill();
	await engine.exited;
}

function lines(text = "") {
	return text.trimEnd().split("\n").filter(Boolean);
}
