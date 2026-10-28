/**
 * Node runtime adapter: `serve()` over `node:http`.
 *
 * Node has no web-standard server, so this module is a small bridge of its own:
 * every `IncomingMessage` becomes a `Request` (headers via `rawHeaders`, body as
 * a web stream), the handler's `Response` is written back onto the
 * `ServerResponse` with backpressure, and a client that goes away aborts the
 * request's `signal`. The handler receives a filled-in {@linkcode DeminoServeInfo}
 * (`remoteAddr`, `upgradeWebSocket`, `raw`) and `serve()` returns the shared
 * {@linkcode ServeHandle}.
 *
 * WebSocket upgrades ride on the optional `ws` package, imported lazily at
 * `serve()` time. When it is missing (or `webSockets: false` is passed) the
 * `info.upgradeWebSocket` capability is simply absent and consumers fall back
 * to plain HTTP (the proxy middleware warns once). Node emits `'upgrade'`
 * instead of `'request'` for upgrade requests, so the adapter runs the same
 * handler from both events; a non-101 answer to an upgrade request is
 * serialised onto the hijacked socket by hand.
 *
 * Scheme is always `http:` - TLS termination is the reverse proxy's job.
 * HTTP/2 is out of scope.
 *
 * @example
 * ```ts
 * import { demino } from "@marianmeres/demino";
 * import { serve } from "@marianmeres/demino/node";
 *
 * const app = demino();
 * app.get("/", () => "Hello");
 *
 * const server = await serve(app, { port: 8000 });
 * // ... later
 * await server.shutdown();
 * ```
 *
 * @module
 */

import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
	STATUS_CODES,
} from "node:http";
import type { AddressInfo } from "node:net";
import { type Duplex, Readable } from "node:stream";
import type {
	DeminoRemoteAddr,
	DeminoServeHandler,
	DeminoServeInfo,
	DeminoUpgradeWebSocket,
} from "../demino.ts";
import { type DeminoListenAddr, logListenInfo } from "../utils/log-listen-info.ts";
import { type ServeFn, type ServeHandle, type ServeOptions, toUrl } from "./types.ts";

/** How long a graceful {@linkcode ServeHandle.shutdown} waits before force-closing. */
const FORCE_CLOSE_MS = 5_000;

// ---------------------------------------------------------------------------
// `ws` - typed locally (the slice this adapter drives), so the module checks
// without `@types/ws` and the import can stay optional
// ---------------------------------------------------------------------------

/** A `ws` server-side socket: the standard `WebSocket` surface plus what the adapter drives. */
interface WsSocket {
	binaryType: string;
	readonly protocol: string;
	readonly readyState: number;
	/** Stop reading from the TCP socket (frames queue up unread). */
	pause(): void;
	resume(): void;
	close(code?: number, reason?: string): void;
	terminate(): void;
	/** `ws` sockets are Node `EventEmitter`s; `onopen` handlers are `'open'` listeners. */
	emit(event: "open"): boolean;
}

interface WsServer {
	readonly clients: Set<WsSocket>;
	/** Synchronous (no `verifyClient` is configured): the callback runs before this returns. */
	handleUpgrade(
		req: IncomingMessage,
		socket: Duplex,
		head: Buffer,
		callback: (socket: WsSocket) => void,
	): void;
}

interface WsModule {
	WebSocketServer: new (options: {
		noServer: true;
		/** Called by `ws` only when the client offered subprotocols; `false` selects none. */
		handleProtocols: (protocols: Set<string>, req: IncomingMessage) => string | false;
	}) => WsServer;
}

let warnedNoWs = false;

/**
 * Lazily imports the optional `ws` package. On failure warns once per process
 * and resolves `undefined` (the upgrade capability stays absent).
 */
async function loadWs(): Promise<WsModule | undefined> {
	try {
		return (await import("ws")) as unknown as WsModule;
	} catch (e) {
		if (!warnedNoWs) {
			warnedNoWs = true;
			console.warn(
				"@marianmeres/demino/node: WebSocket upgrades are disabled - the optional " +
					`dependency "ws" could not be loaded (${
						(e as Error)?.message ?? e
					}). Install it (npm i ws) or pass { webSockets: false } to silence this.`,
			);
		}
		return undefined;
	}
}

/** `Sec-WebSocket-Key`: 16 random bytes, base64 (same check `ws` applies). */
const WS_KEY = /^[+/0-9A-Za-z]{22}==$/;

/**
 * Deno parity: `upgradeWebSocket` on a request that is not a WebSocket
 * handshake throws a `TypeError` (instead of letting `ws` answer with its own
 * 400 behind the handler's back).
 */
function assertUpgradeRequest(req: IncomingMessage): void {
	const { upgrade, "sec-websocket-key": key, "sec-websocket-version": version } =
		req.headers;
	const ok = req.method === "GET" &&
		typeof upgrade === "string" &&
		upgrade.toLowerCase() === "websocket" &&
		typeof key === "string" &&
		WS_KEY.test(key) &&
		(version === "13" || version === "8");
	if (!ok) {
		throw new TypeError(
			"Invalid WebSocket upgrade request (expected GET with `Upgrade: websocket`, " +
				"`Sec-WebSocket-Key` and `Sec-WebSocket-Version: 13`)",
		);
	}
}

/**
 * The `101 Switching Protocols` a handler returns to commit an upgrade. The
 * `Response` constructor refuses 1xx statuses, so a 200 is built and its
 * `status`/`statusText`/`ok` are shadowed on the instance. Never written to the
 * wire: `ws` has already sent the real handshake by the time it exists.
 */
function createUpgradedResponse(protocol: string): Response {
	const headers: Record<string, string> = {
		upgrade: "websocket",
		connection: "Upgrade",
	};
	if (protocol) headers["sec-websocket-protocol"] = protocol;
	const res = new Response(null, { status: 200, headers });
	Object.defineProperties(res, {
		status: { value: 101 },
		statusText: { value: "Switching Protocols" },
		ok: { value: false },
	});
	return res;
}

// ---------------------------------------------------------------------------
// request / response bridge (adapter-internal, reused by the upgrade path and tests)
// ---------------------------------------------------------------------------

/** Request targets in absolute form (`GET http://host/path HTTP/1.1`, sent by proxies). */
const ABSOLUTE_TARGET = /^https?:\/\//i;

/** `host:port` for a `Host`-less (HTTP/1.0) request, IPv6 bracketed. */
function authority({ hostname, port }: DeminoListenAddr): string {
	return `${hostname.includes(":") ? `[${hostname}]` : hostname}:${port}`;
}

/** Does the message carry a body? GET/HEAD never; otherwise a declared non-zero length or chunked framing. */
function hasBody(req: IncomingMessage): boolean {
	const method = req.method ?? "GET";
	if (method === "GET" || method === "HEAD") return false;
	if (req.headers["transfer-encoding"]) return true;
	const length = req.headers["content-length"];
	return length !== undefined && length !== "0";
}

/**
 * Builds the web `Request` for an incoming Node message.
 *
 * Headers come from `rawHeaders` so duplicates (several `Cookie` lines, …)
 * survive; the body is the message itself as a web stream (`duplex: "half"` is
 * what undici requires for a streaming body). The URL is `http://` + the `Host`
 * header (falling back to the listener's own address) + the request target.
 *
 * Throws on a malformed request (bad `Host`, invalid header); the caller
 * answers 400.
 *
 * Adapter-internal (not exported from the package root).
 */
export function toRequest(
	req: IncomingMessage,
	signal: AbortSignal,
	listen: DeminoListenAddr,
): Request {
	const target = req.url ?? "/";
	const url = ABSOLUTE_TARGET.test(target)
		? target
		: `http://${req.headers.host ?? authority(listen)}${target}`;

	const headers = new Headers();
	const raw = req.rawHeaders;
	for (let i = 0; i < raw.length; i += 2) headers.append(raw[i], raw[i + 1]);

	const init: RequestInit & { duplex?: "half" } = {
		method: req.method ?? "GET",
		headers,
		signal,
	};
	if (hasBody(req)) {
		init.body = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>;
		init.duplex = "half";
	}
	return new Request(url, init);
}

/** Resolves on `'drain'`, or at once when the response can no longer be written. */
function waitDrain(out: ServerResponse): Promise<void> {
	return new Promise((resolve) => {
		if (out.destroyed || out.writableFinished) return resolve();
		const done = () => {
			out.off("drain", done);
			out.off("close", done);
			out.off("error", done);
			resolve();
		};
		out.once("drain", done);
		out.once("close", done);
		out.once("error", done);
	});
}

/**
 * Writes a web `Response` onto a `ServerResponse`: status, headers (multi-value
 * `Set-Cookie` preserved), then the body with backpressure. `Content-Length` is
 * never invented - Node chunk-encodes when the `Response` carries none and
 * honours it when it does. For `HEAD` the body is cancelled, never read. A
 * client that disconnects mid-body cancels the body stream.
 *
 * Adapter-internal (not exported from the package root).
 */
export async function writeResponse(
	res: Response,
	out: ServerResponse,
	isHead: boolean,
): Promise<void> {
	const headers: Record<string, string | string[]> = {};
	res.headers.forEach((value, name) => {
		if (name !== "set-cookie") headers[name] = value;
	});
	const cookies = res.headers.getSetCookie();
	if (cookies.length) headers["set-cookie"] = cookies;
	// an empty body is a known length (Deno sends `content-length: 0` too); every
	// other length is the `Response`'s business - Node chunk-encodes when absent
	if (
		!res.body && !isHead && res.status >= 200 && res.status !== 204 &&
		res.status !== 304 && !("content-length" in headers) &&
		!("transfer-encoding" in headers)
	) {
		headers["content-length"] = "0";
	}

	if (res.statusText) out.writeHead(res.status, res.statusText, headers);
	else out.writeHead(res.status, headers);

	if (!res.body || isHead) {
		// HEAD: the handler may have produced a body (GET fallback); drop it unread
		if (res.body) res.body.cancel().catch(() => {});
		out.end();
		return;
	}

	const reader = res.body.getReader();
	out.once("close", () => {
		// closed before `end()` flushed = the client went away: stop producing
		if (!out.writableFinished) reader.cancel().catch(() => {});
	});

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done || out.destroyed) break;
			if (!out.write(value)) await waitDrain(out);
		}
		out.end();
	} catch {
		// the body stream failed after the status line went out: the only honest
		// signal left is a truncated connection
		reader.cancel().catch(() => {});
		out.destroy();
	}
}

/**
 * Serialises a (non-101) `Response` onto a socket Node handed over for an
 * upgrade - there is no `ServerResponse` on that path. The body is buffered
 * (these are error pages, not streams) and the connection is closed after it.
 *
 * Adapter-internal (not exported from the package root).
 */
export async function writeRawResponse(socket: Duplex, res: Response): Promise<void> {
	const body = new Uint8Array(await res.arrayBuffer());
	if (socket.destroyed) return;

	const reason = res.statusText || STATUS_CODES[res.status] || "";
	const lines = [`HTTP/1.1 ${res.status} ${reason}`.trimEnd()];
	res.headers.forEach((value, name) => {
		if (
			name !== "set-cookie" && name !== "content-length" &&
			name !== "transfer-encoding" && name !== "connection"
		) {
			lines.push(`${name}: ${value}`);
		}
	});
	for (const cookie of res.headers.getSetCookie()) lines.push(`set-cookie: ${cookie}`);
	const bodyless = res.status === 204 || res.status === 304;
	if (!bodyless) lines.push(`content-length: ${body.byteLength}`);
	lines.push("connection: close", "", "");

	socket.write(lines.join("\r\n"));
	socket.end(bodyless ? undefined : body);
}

/** IPv4-mapped IPv6 (`::ffff:10.0.0.1`, seen when listening on `::`) → plain IPv4, as Deno reports it. */
function normalizeMapped(ip: string): string {
	return ip.startsWith("::ffff:") && ip.includes(".") ? ip.slice(7) : ip;
}

/** Read at request start: the socket's peer is gone once the connection closes. */
function remoteAddrOf(req: IncomingMessage): DeminoRemoteAddr {
	const socket = req.socket;
	return {
		hostname: normalizeMapped(socket?.remoteAddress ?? ""),
		port: socket?.remotePort ?? 0,
		transport: "tcp",
	};
}

function defaultOnError(error: unknown): Response {
	console.error(error);
	return new Response("Internal Server Error", { status: 500 });
}

// ---------------------------------------------------------------------------
// serve()
// ---------------------------------------------------------------------------

/**
 * Starts a Demino app (or any {@linkcode DeminoServeHandler}) on a `node:http`
 * server.
 *
 * Defaults follow `Deno.serve`: `0.0.0.0:8000`, `onListen` prints the listen
 * info (see `logListenInfo`). `info.upgradeWebSocket` is provided through the
 * optional `ws` package unless `webSockets: false`.
 *
 * @param handler - The app or composed handler
 * @param options - Listen options (see {@linkcode ServeOptions})
 * @returns The running server's {@linkcode ServeHandle}
 * @throws Error when the port cannot be bound (e.g. `EADDRINUSE`)
 */
export const serve: ServeFn = async (
	handler: DeminoServeHandler,
	options: ServeOptions = {},
): Promise<ServeHandle> => {
	const onError = options.onError ?? defaultOnError;

	// --- optional WebSocket engine ---------------------------------------------
	let wss: WsServer | undefined;
	// `handleProtocols` has no way to receive per-upgrade data, so the protocol
	// the handler asked for is parked here around the (synchronous) handshake
	let pendingProtocol: string | undefined;
	if (options.webSockets !== false) {
		const ws = await loadWs();
		if (ws) {
			wss = new ws.WebSocketServer({
				noServer: true,
				handleProtocols: () => pendingProtocol ?? false,
			});
		}
	}

	/** Sockets Node handed over on `'upgrade'`: outside `closeAllConnections()`'s reach, so tracked here for force-close. */
	const hijacked = new Set<Duplex>();

	let listen: DeminoListenAddr = { hostname: options.hostname ?? "0.0.0.0", port: 0 };

	const fail = async (error: unknown): Promise<Response> => {
		try {
			return await onError(error);
		} catch {
			return new Response("Internal Server Error", { status: 500 });
		}
	};

	/** `Request` for the message, or a 400 when it cannot be built. */
	const buildRequest = (
		req: IncomingMessage,
		signal: AbortSignal,
	): Request | Response => {
		try {
			return toRequest(req, signal, listen);
		} catch {
			return new Response("Bad Request", { status: 400 });
		}
	};

	const run = async (
		req: IncomingMessage,
		signal: AbortSignal,
		info: DeminoServeInfo,
	): Promise<Response> => {
		const request = buildRequest(req, signal);
		if (request instanceof Response) return request;
		try {
			return await handler(request, info);
		} catch (e) {
			return await fail(e);
		}
	};

	// --- 'request' -------------------------------------------------------------
	const onRequest = async (req: IncomingMessage, res: ServerResponse) => {
		const ac = new AbortController();
		// `'close'` before `end()` flushed = the client (or a force-close) went away
		res.once("close", () => {
			if (!res.writableFinished) ac.abort();
		});

		const info: DeminoServeInfo = { remoteAddr: remoteAddrOf(req), raw: req };
		if (wss) {
			// Deno parity: the capability exists on every request and refuses one
			// that is not an upgrade (Node routed this one to 'request', not 'upgrade')
			info.upgradeWebSocket = (upgradeReq) => {
				throw new TypeError(
					`upgradeWebSocket: not an upgrade request (${upgradeReq.method} ${upgradeReq.url})`,
				);
			};
		}

		const response = await run(req, ac.signal, info);
		await writeResponse(response, res, req.method === "HEAD");
	};

	// --- 'upgrade' -------------------------------------------------------------
	const onUpgrade = async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
		// Node detached its own listeners when it emitted 'upgrade': from here a
		// peer reset would be an unhandled 'error' (process crash) without this
		socket.on("error", () => {});
		hijacked.add(socket);
		socket.once("close", () => hijacked.delete(socket));

		const ac = new AbortController();
		socket.once("close", () => ac.abort());

		let upgraded: { socket: WsSocket; response: Response } | undefined;
		// `ws` found the handshake malformed after our own check, answered 400 and
		// destroyed the socket itself - nothing is left to write to
		let handshakeAborted = false;

		const info: DeminoServeInfo = { remoteAddr: remoteAddrOf(req), raw: req };
		if (wss) {
			const engine = wss;
			const upgradeWebSocket: DeminoUpgradeWebSocket = (_req, opts) => {
				if (upgraded) throw new TypeError("upgradeWebSocket: already upgraded");
				assertUpgradeRequest(req);

				let ws: WsSocket | undefined;
				pendingProtocol = opts?.protocol || undefined;
				try {
					engine.handleUpgrade(req, socket, head, (s) => (ws = s));
				} finally {
					pendingProtocol = undefined;
				}
				if (!ws) {
					handshakeAborted = true;
					throw new TypeError("upgradeWebSocket: handshake rejected");
				}

				// `ws` server sockets are born OPEN and never emit 'open'. Deno's
				// contract is CONNECTING until the 101 has been returned, then
				// 'open' - so hold incoming frames until the handler is done and
				// fire 'open' once it has committed (see below). `arraybuffer` is
				// the deterministic binary type of the standard API.
				ws.binaryType = "arraybuffer";
				ws.pause();

				const response = createUpgradedResponse(ws.protocol);
				upgraded = { socket: ws, response };
				return { socket: ws as unknown as WebSocket, response };
			};
			info.upgradeWebSocket = upgradeWebSocket;
		}

		const response = await run(req, ac.signal, info);

		if (upgraded) {
			if (response === upgraded.response) {
				upgraded.socket.emit("open");
				upgraded.socket.resume();
			} else {
				// the handler upgraded but answered with something else: the 101 is
				// already on the wire, so the only consistent outcome is a close
				upgraded.socket.resume();
				upgraded.socket.close(1011, "Upgrade abandoned by the handler");
			}
			return;
		}
		if (handshakeAborted) return;
		await writeRawResponse(socket, response);
	};

	// --- server ----------------------------------------------------------------
	const server: Server = createServer();
	server.on("request", (req, res) => {
		onRequest(req, res).catch(() => res.destroy());
	});
	server.on("upgrade", (req, socket, head) => {
		onUpgrade(req, socket, head).catch(() => socket.destroy());
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port ?? 8000, options.hostname ?? "0.0.0.0", () => {
			server.off("error", reject);
			resolve();
		});
	});
	// post-listen errors (accept failures) must not crash the process unhandled
	server.on("error", (e) => console.error("@marianmeres/demino/node: server error", e));

	const addr = server.address() as AddressInfo;
	listen = { hostname: addr.address, port: addr.port };

	const finished = new Promise<void>((resolve) =>
		server.once("close", () => resolve())
	);

	/** Close now: listener, every HTTP connection, every hijacked/WebSocket socket. */
	const forceClose = () => {
		server.close();
		server.closeAllConnections();
		for (const s of hijacked) s.destroy();
		for (const ws of wss?.clients ?? []) ws.terminate();
	};

	let closing: Promise<void> | undefined;
	const shutdown = (): Promise<void> => {
		closing ??= (async () => {
			server.close(); // stop accepting; 'close' fires once every connection has ended
			server.closeIdleConnections();
			// a WebSocket is not an in-flight request: say goodbye instead of waiting
			for (const ws of wss?.clients ?? []) ws.close(1001, "Server shutting down");
			const timer = setTimeout(forceClose, FORCE_CLOSE_MS);
			await finished;
			clearTimeout(timer);
		})();
		return closing;
	};

	// Deno.serve parity: aborting the signal closes the server and all of its
	// connections at once (graceful is `shutdown()`)
	const abort = () => {
		closing ??= finished;
		forceClose();
	};
	if (options.signal?.aborted) abort();
	else options.signal?.addEventListener("abort", abort, { once: true });

	(options.onListen ?? logListenInfo)(listen);

	const handle: ServeHandle = {
		hostname: listen.hostname,
		port: listen.port,
		url: toUrl(listen),
		finished,
		shutdown,
		ref: () => void server.ref(),
		unref: () => void server.unref(),
	};

	return handle;
};
