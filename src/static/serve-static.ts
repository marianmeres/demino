import { close, constants, fstat, open, read, type Stats } from "node:fs";
import { access, stat } from "node:fs/promises";
import { extname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { contentTypeFor } from "./mime.ts";

/**
 * Extra response headers for {@linkcode serveStatic}: a static `HeadersInit`, or a
 * per-request function receiving the request and the resolved file path (e.g. a
 * `Cache-Control` policy by path). Return `undefined`/`null` to add nothing.
 */
export type DeminoStaticHeaders =
	| HeadersInit
	| ((req: Request, filePath: string) => HeadersInit | undefined | null);

/** Options shared by `app.static()` and {@linkcode serveStatic}. */
export interface DeminoStaticOptions {
	/** Serve `index.html` for a directory request. Default `true`. */
	showIndex?: boolean;
	/**
	 * Serve paths with a dot-segment (`/.env`, `/.well-known/x`). Default `false`
	 * (such paths are a 404).
	 */
	showDotfiles?: boolean;
	/**
	 * Emit `ETag` + `Last-Modified` and honour `If-None-Match` / `If-Modified-Since`
	 * with a 304. Default `true`. Without them an `If-Range` can never hold, so a
	 * conditional range request gets the whole file.
	 */
	etag?: boolean;
	/**
	 * Extra response headers, applied with `set` (so they override a computed header
	 * of the same name) on 200/206/304 responses only — never on redirects or
	 * errors. See {@linkcode DeminoStaticHeaders}.
	 */
	headers?: DeminoStaticHeaders;
}

/** Options of the standalone {@linkcode serveStatic}. */
export interface ServeStaticOptions extends DeminoStaticOptions {
	/** Directory to serve from (resolved against the current working directory). */
	fsRoot: string;
	/**
	 * URL path prefix without the leading slash (`"files"`, `"api/files"`) that is
	 * stripped from the request path before it is mapped onto `fsRoot`; a request
	 * outside of it is a 404. `app.static` derives it from the mount path + route.
	 * Default: none (the whole pathname maps onto `fsRoot`).
	 */
	urlRoot?: string;
}

const STATUS_TEXT: Record<number, string> = {
	400: "Bad Request",
	404: "Not Found",
	405: "Method Not Allowed",
	416: "Range Not Satisfiable",
};

function plain(status: number, headers?: HeadersInit): Response {
	return new Response(STATUS_TEXT[status], { status, headers });
}

/**
 * 301 with a *relative* `Location` (path + query), like Demino's `redirect()` and
 * `trailingSlash()`: an absolute `http://` one is wrong behind a TLS-terminating
 * proxy.
 */
function redirect(location: string): Response {
	return new Response(null, { status: 301, headers: { location } });
}

/**
 * Percent-encodes a decoded path for a `Location`, segment by segment, so that
 * decoding it yields the same path again - a literal `%`, `?` or `#` in a file
 * name included (the `URL.pathname` setter would leave a `%` as it is, and the
 * redirect would point at a URL that no longer decodes).
 */
function encodePath(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}

function isNotFound(e: unknown): boolean {
	const code = (e as { code?: unknown } | null)?.code;
	return code === "ENOENT" || code === "ENOTDIR" || code === "ENAMETOOLONG";
}

/**
 * Serves a file or a directory `index.html` from `fsRoot` for a `GET`/`HEAD`
 * request — `Request` in, `Response` out, no server or Demino context involved.
 * This is what `app.static()` calls; it is exported for wrappers that need the
 * same behaviour under their own route.
 *
 * Behaviour:
 * - other methods → 405 with `Allow: GET, HEAD`;
 * - malformed percent-encoding → 400;
 * - a path that normalises differently (`/a//b`, `/a/./b`) → 301 to the normalised
 *   path; a file requested with a trailing slash → 301 without it; a directory
 *   without one → 301 with it (so relative links in `index.html` resolve);
 * - a path outside `urlRoot`, a dot-segment (unless `showDotfiles`), a backslash
 *   or NUL, anything that would resolve outside `fsRoot`, and a missing file →
 *   404;
 * - a file → 200 with `Content-Type`, `Content-Length`, `Accept-Ranges: bytes`,
 *   weak `ETag` (`W/"<size>-<mtime>"`, hex) + `Last-Modified`; `If-None-Match` /
 *   `If-Modified-Since` → 304 without a body; a single `Range` → 206 with
 *   `Content-Range` (unparsable → the whole file with 200, unsatisfiable → 416
 *   with `bytes *\/<size>`, ignored on an empty file, and applied only while an
 *   `If-Range` date equals `Last-Modified` - otherwise the whole file); `HEAD` →
 *   the same headers, no body;
 * - a directory → its `index.html` when `showIndex` (default), else 404.
 *
 * The body is exactly `Content-Length` bytes of the file the headers describe: a
 * file that grows meanwhile is not read past them, while one that is truncated,
 * or replaced by another file before the first read, errors the body (a cut-off
 * response, never a stalled or a mixed one). The file is opened when the body is
 * first read and closed when it has been read to the end, cancelled or failed -
 * a `Response` whose body is never read holds no descriptor.
 *
 * Filesystem errors other than "not found" (e.g. `EACCES` on a file that exists
 * but cannot be read, checked before the response is created) are thrown, so a
 * Demino app routes them through its error handler like any other handler error.
 *
 * @example
 * ```ts
 * import { serveStatic } from "@marianmeres/demino";
 *
 * app.get("/public/*", (req) =>
 *   serveStatic(req, {
 *     fsRoot: "./public",
 *     urlRoot: "public",
 *     headers: (req) => ({
 *       "cache-control": new URL(req.url).pathname.startsWith("/public/assets/")
 *         ? "public, max-age=31536000, immutable"
 *         : "no-cache",
 *     }),
 *   }));
 * ```
 */
export async function serveStatic(
	req: Request,
	opts: ServeStaticOptions,
): Promise<Response> {
	if (req.method !== "GET" && req.method !== "HEAD") {
		return plain(405, { allow: "GET, HEAD" });
	}

	const url = new URL(req.url);
	let decoded: string;
	try {
		decoded = decodeURIComponent(url.pathname);
	} catch {
		return plain(400);
	}

	// A percent-encoded backslash (`%5C`) is a separator on Windows and would
	// bypass the POSIX-based checks; NUL cannot be part of a path at all. Refused
	// before anything else, so neither is ever echoed into a redirect.
	if (decoded.includes("\\") || decoded.includes("\0")) return plain(404);

	const normalized = posix.normalize(decoded);

	// The prefix is checked on the *normalised* path, so `/files/../x` can never
	// escape the mount (and is a 404, not a redirect that would leak the mapping).
	const urlRoot = (opts.urlRoot ?? "").replace(/^\/+|\/+$/g, "");
	let rel = normalized;
	if (urlRoot) {
		const prefix = `/${urlRoot}`;
		if (normalized !== prefix && !normalized.startsWith(`${prefix}/`)) {
			return plain(404);
		}
		rel = normalized.slice(prefix.length);
	}

	// `/foo////bar`, `/foo/./bar`, `/foo/bar/////` → 301 to the normalised path.
	if (normalized !== decoded) return redirect(encodePath(normalized) + url.search);

	// Trailing slash is only a redirect concern (below); the fs lookup drops it.
	if (rel.endsWith("/")) rel = rel.slice(0, -1);

	if (!opts.showDotfiles && /\/\./.test(rel)) return plain(404);

	// Map onto the root, then prove containment by resolution as well — the
	// normalisation above should already guarantee it (defense in depth).
	const root = resolve(opts.fsRoot);
	const fsPath = join(root, rel);
	const inside = relative(root, fsPath);
	if (isAbsolute(inside) || inside === ".." || inside.startsWith(`..${sep}`)) {
		return plain(404);
	}

	let info: Stats;
	try {
		info = await stat(fsPath);
	} catch (e) {
		if (isNotFound(e)) return plain(404);
		throw e;
	}

	// Both redirects below reuse the pathname as it was requested (it decoded and
	// normalised to itself), so there is nothing to re-encode.
	if (info.isFile()) {
		if (url.pathname.endsWith("/")) {
			return redirect(url.pathname.slice(0, -1) + url.search);
		}
		return serveFile(req, fsPath, info, opts);
	}

	if (info.isDirectory()) {
		if (!url.pathname.endsWith("/")) {
			return redirect(`${url.pathname}/${url.search}`);
		}
		if (opts.showIndex ?? true) {
			const indexPath = join(fsPath, "index.html");
			let indexInfo: Stats | undefined;
			try {
				indexInfo = await stat(indexPath);
			} catch (e) {
				if (!isNotFound(e)) throw e;
			}
			if (indexInfo?.isFile()) return serveFile(req, indexPath, indexInfo, opts);
		}
		return plain(404);
	}

	// sockets, fifos, devices, …
	return plain(404);
}

/** `Range: bytes=<start>-<end>` (single range only), the same shape 1.x accepted. */
function parseRange(value: string, size: number): { start: number; end: number } | null {
	const m = /bytes=(?<start>\d+)?-(?<end>\d+)?$/u.exec(value);
	if (!m?.groups) return null;
	const { start, end } = m.groups;
	if (start !== undefined) {
		return { start: +start, end: end !== undefined ? +end : size - 1 };
	}
	// `bytes=-100` → the last 100 bytes
	if (end !== undefined) return { start: size - +end, end: size - 1 };
	return null;
}

/** Weak comparison (RFC 9110 §8.8.3.2): `W/` prefixes are ignored, `*` matches anything. */
function etagMatches(ifNoneMatch: string, etag: string): boolean {
	const strip = (v: string) => v.trim().replace(/^W\//, "");
	if (ifNoneMatch.trim() === "*") return true;
	const target = strip(etag);
	return ifNoneMatch.split(",").some((v) => strip(v) === target);
}

function isNotModified(reqHeaders: Headers, etag: string, mtimeMs: number): boolean {
	const ifNoneMatch = reqHeaders.get("if-none-match");
	if (ifNoneMatch !== null) return etagMatches(ifNoneMatch, etag);
	const ifModifiedSince = reqHeaders.get("if-modified-since");
	if (ifModifiedSince) {
		const since = Date.parse(ifModifiedSince);
		// `Last-Modified` has second precision, the stored mtime has not.
		return !Number.isNaN(since) && mtimeMs < since + 1000;
	}
	return false;
}

/**
 * `If-Range` (RFC 9110 §13.1.5): a `Range` applies only while the validator the
 * client holds still names this version of the file, otherwise the whole file is
 * sent - which is what keeps a resumed download from splicing two versions
 * together. No header → the range applies. An entity-tag never qualifies: the
 * comparison has to be a strong one and the tags issued here are weak (a client
 * must not send one of those in `If-Range` anyway), so in practice the validator
 * is the `Last-Modified` date, which has to match exactly.
 */
function ifRangeHolds(
	reqHeaders: Headers,
	mtimeMs: number,
	validators: boolean,
): boolean {
	const ifRange = reqHeaders.get("if-range")?.trim();
	if (ifRange === undefined) return true;
	// `etag: false` never sent a `Last-Modified`, so no date can be vouched for
	if (!validators || ifRange.startsWith('"') || ifRange.startsWith("W/")) return false;
	// `Last-Modified` has second precision, the stored mtime has not
	return Date.parse(ifRange) === Math.floor(mtimeMs / 1000) * 1000;
}

function applyHeaders(
	target: Headers,
	custom: DeminoStaticHeaders | undefined,
	req: Request,
	filePath: string,
): Headers {
	const init = typeof custom === "function" ? custom(req, filePath) : custom;
	if (init) {
		for (const [k, v] of new Headers(init)) target.set(k, v);
	}
	return target;
}

/** Bytes per read - the chunk size of `node:fs`'s own streams. */
const CHUNK_SIZE = 64 * 1024;

// Plain descriptors through the callback API, not `fs/promises` file handles: a
// handle that is garbage-collected while still open is a process-level error on
// current Node, and nothing can stop a consumer from dropping a body stream.

function openFd(path: string): Promise<number> {
	return new Promise((resolve, reject) => {
		open(path, "r", (e, fd) => (e ? reject(e) : resolve(fd)));
	});
}

function fstatFd(fd: number): Promise<Stats> {
	return new Promise((resolve, reject) => {
		fstat(fd, (e, stats) => (e ? reject(e) : resolve(stats)));
	});
}

/** Resolves with the number of bytes read into `buffer` (`0` at the end of the file). */
function readFd(fd: number, buffer: Uint8Array, position: number): Promise<number> {
	return new Promise((resolve, reject) => {
		read(fd, buffer, 0, buffer.byteLength, position, (e, bytesRead) =>
			e ? reject(e) : resolve(bytesRead),
		);
	});
}

/** Never rejects: there is nothing left to do about a descriptor that failed to close. */
function closeFd(fd: number): Promise<void> {
	return new Promise((resolve) => {
		close(fd, () => resolve());
	});
}

/**
 * `length` bytes of the file from `start`, as a web stream.
 *
 * Pull-based with nothing buffered ahead (`highWaterMark: 0`): the file is opened
 * on the first read the consumer asks for, so a body that is never read holds no
 * descriptor, and it is closed once the last byte was delivered, when the
 * consumer cancels, and when a read fails.
 *
 * What is delivered is exactly `length` bytes of the file `info` describes:
 * - opened as another file (the path was replaced after the `stat`, e.g. by a
 *   deploy) → an error, since the headers already sent describe the old one;
 * - grown meanwhile → not read past `length`;
 * - come up short (truncated while being served) → an error instead of a clean
 *   end, which with `Content-Length` announced would leave the client waiting
 *   for bytes that never come.
 */
function fileBody(
	filePath: string,
	info: Stats,
	start: number,
	length: number,
): ReadableStream<Uint8Array> {
	let fd: number | undefined;
	let position = start;
	let remaining = length;
	/** A `pull` is between its first and last line: the descriptor may be in use. */
	let pulling = false;
	/** Fully read, failed or cancelled: nothing more will be delivered. */
	let done = false;

	const release = async () => {
		if (fd === undefined) return;
		const opened = fd;
		fd = undefined;
		await closeFd(opened);
	};

	return new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				pulling = true;
				try {
					let handle = fd;
					if (handle === undefined) {
						handle = fd = await openFd(filePath);
						const opened = await fstatFd(handle);
						if (done) return;
						if (
							!opened.isFile() ||
							opened.dev !== info.dev ||
							opened.ino !== info.ino
						) {
							throw new Error(
								`serveStatic: "${filePath}" was replaced while being served`,
							);
						}
					}
					const chunk = new Uint8Array(Math.min(CHUNK_SIZE, remaining));
					const bytesRead = await readFd(handle, chunk, position);
					if (done) return;
					if (bytesRead === 0) {
						throw new Error(
							`serveStatic: "${filePath}" was truncated while being served`,
						);
					}
					position += bytesRead;
					remaining -= bytesRead;
					controller.enqueue(
						bytesRead < chunk.byteLength
							? chunk.subarray(0, bytesRead)
							: chunk,
					);
					if (remaining === 0) {
						done = true;
						controller.close();
					}
				} catch (e) {
					// after a cancel there is nobody left to tell
					if (!done) {
						done = true;
						controller.error(e);
					}
				} finally {
					pulling = false;
					if (done) await release();
				}
			},
			async cancel() {
				done = true;
				// a read in flight still uses the descriptor: its `finally` closes it
				if (!pulling) await release();
			},
		},
		{ highWaterMark: 0 },
	);
}

/** Weak: tells two versions of a file apart, promises nothing about its bytes. */
function etagOf(info: Stats): string {
	return `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
}

async function serveFile(
	req: Request,
	filePath: string,
	info: Stats,
	opts: ServeStaticOptions,
): Promise<Response> {
	const size = info.size;
	const validators = opts.etag ?? true;
	const headers = new Headers({
		"accept-ranges": "bytes",
		"content-type": contentTypeFor(extname(filePath)),
	});
	/** The answer for this file: the caller's `headers` option applies to these only. */
	const respond = (status: number, body: ReadableStream<Uint8Array> | null) =>
		new Response(body, {
			status,
			headers: applyHeaders(headers, opts.headers, req, filePath),
		});

	if (validators) {
		const etag = etagOf(info);
		headers.set("etag", etag);
		headers.set("last-modified", new Date(info.mtimeMs).toUTCString());
		if (isNotModified(req.headers, etag, info.mtimeMs)) return respond(304, null);
	}

	if (req.method === "HEAD") {
		headers.set("content-length", `${size}`);
		return respond(200, null);
	}

	let status = 200;
	let start = 0;
	let end = size - 1;

	const rangeValue = req.headers.get("range");
	// Some clients add a Range header to every request; on an empty file answer
	// with a plain 200 rather than a 416 (as Go's net/http and 1.x did).
	if (rangeValue && size > 0 && ifRangeHolds(req.headers, info.mtimeMs, validators)) {
		const parsed = parseRange(rangeValue, size);
		if (parsed) {
			if (parsed.end < 0 || parsed.end < parsed.start || parsed.start >= size) {
				return plain(416, {
					"accept-ranges": "bytes",
					"content-range": `bytes */${size}`,
				});
			}
			status = 206;
			start = Math.max(0, parsed.start);
			end = Math.min(parsed.end, size - 1);
			headers.set("content-range", `bytes ${start}-${end}/${size}`);
		}
		// unparsable `Range` → the whole file
	}

	const length = end - start + 1; // 0 only for an empty file
	headers.set("content-length", `${length}`);
	if (length === 0) return respond(status, null);

	// The file is opened only when the body is first read, which is after the
	// status line went out - too late to report a file that cannot be read. So
	// that is checked here, where a failure is still a thrown error.
	try {
		await access(filePath, constants.R_OK);
	} catch (e) {
		if (isNotFound(e)) return plain(404);
		throw e;
	}
	return respond(status, fileBody(filePath, info, start, length));
}
