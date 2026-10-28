import { createReadStream, type Stats } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
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
	 * with a 304. Default `true`.
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
function redirect(url: URL): Response {
	return new Response(null, {
		status: 301,
		headers: { location: url.pathname + url.search },
	});
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
 * - a path outside `urlRoot`, a dot-segment (unless `showDotfiles`), anything
 *   that would resolve outside `fsRoot`, and a missing file → 404;
 * - a file → 200 with `Content-Type`, `Content-Length`, `Accept-Ranges: bytes`,
 *   weak `ETag` (`W/"<size>-<mtime>"`, hex) + `Last-Modified`; `If-None-Match` /
 *   `If-Modified-Since` → 304 without a body; a single `Range` → 206 with
 *   `Content-Range` (unparsable → the whole file with 200, unsatisfiable → 416
 *   with `bytes *\/<size>`, ignored on an empty file); `HEAD` → the same headers,
 *   no body;
 * - a directory → its `index.html` when `showIndex` (default), else 404.
 *
 * Filesystem errors other than "not found" (e.g. `EACCES`) are thrown, so a Demino
 * app routes them through its error handler like any other handler error.
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
	if (normalized !== decoded) {
		url.pathname = normalized; // the setter re-encodes what needs encoding
		return redirect(url);
	}

	// Trailing slash is only a redirect concern (below); the fs lookup drops it.
	if (rel.endsWith("/")) rel = rel.slice(0, -1);

	// A percent-encoded backslash (`%5C`) is a separator on Windows and would
	// bypass the POSIX-based checks; NUL cannot be part of a path at all.
	if (rel.includes("\\") || rel.includes("\0")) return plain(404);

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

	if (info.isFile()) {
		if (url.pathname.endsWith("/")) {
			url.pathname = url.pathname.slice(0, -1);
			return redirect(url);
		}
		return serveFile(req, fsPath, info, opts);
	}

	if (info.isDirectory()) {
		if (!url.pathname.endsWith("/")) {
			url.pathname += "/";
			return redirect(url);
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
function parseRange(
	value: string,
	size: number,
): { start: number; end: number } | null {
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

function fileBody(
	filePath: string,
	range?: { start: number; end: number },
): ReadableStream<Uint8Array> {
	return Readable.toWeb(
		createReadStream(filePath, range),
	) as ReadableStream<Uint8Array>;
}

function serveFile(
	req: Request,
	filePath: string,
	info: Stats,
	opts: ServeStaticOptions,
): Response {
	const size = info.size;
	const headers = new Headers({
		"accept-ranges": "bytes",
		"content-type": contentTypeFor(extname(filePath)),
	});

	const useEtag = opts.etag ?? true;
	if (useEtag) {
		const etag = `W/"${size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
		headers.set("etag", etag);
		headers.set("last-modified", new Date(info.mtimeMs).toUTCString());
		if (isNotModified(req.headers, etag, info.mtimeMs)) {
			return new Response(null, {
				status: 304,
				headers: applyHeaders(headers, opts.headers, req, filePath),
			});
		}
	}

	if (req.method === "HEAD") {
		headers.set("content-length", `${size}`);
		return new Response(null, {
			status: 200,
			headers: applyHeaders(headers, opts.headers, req, filePath),
		});
	}

	const rangeValue = req.headers.get("range");
	// Some clients add a Range header to every request; on an empty file answer
	// with a plain 200 rather than a 416 (as Go's net/http and 1.x did).
	if (rangeValue && size > 0) {
		const parsed = parseRange(rangeValue, size);
		if (parsed) {
			if (parsed.end < 0 || parsed.end < parsed.start || parsed.start >= size) {
				return plain(416, {
					"accept-ranges": "bytes",
					"content-range": `bytes */${size}`,
				});
			}
			const start = Math.max(0, parsed.start);
			const end = Math.min(parsed.end, size - 1);
			headers.set("content-range", `bytes ${start}-${end}/${size}`);
			headers.set("content-length", `${end - start + 1}`);
			return new Response(fileBody(filePath, { start, end }), {
				status: 206,
				headers: applyHeaders(headers, opts.headers, req, filePath),
			});
		}
		// unparsable `Range` → the whole file
	}

	headers.set("content-length", `${size}`);
	return new Response(fileBody(filePath), {
		status: 200,
		headers: applyHeaders(headers, opts.headers, req, filePath),
	});
}
