/**
 * Bun runtime adapter: `serve()` over `Bun.serve`.
 *
 * `Bun.serve({ fetch })` is web-standard, so the request/response path needs
 * no bridge. WebSockets are the structurally different part: Bun upgrades with
 * `server.upgrade(req, { data })` (a boolean, after which `fetch` must return
 * `undefined`) and delivers socket events on one *server-level*
 * `websocket: { open, message, close }` object instead of on a per-socket
 * `WebSocket`. This module wraps every upgraded connection in a per-socket
 * facade ({@linkcode BunSocket}) that looks like a standard `WebSocket` to the
 * handler - `onopen`/`onmessage`/`onclose`/`onerror`, `send`, `close`,
 * `readyState`, `protocol`, `binaryType` - so `info.upgradeWebSocket` has the
 * same Deno-shaped contract on Bun as on the other runtimes.
 *
 * Bun fires `websocket.open` synchronously inside `server.upgrade()` and
 * delivers frames while the handler is still running (probed on Bun 1.4.3).
 * The contract is CONNECTING until the handler has returned the 101, then
 * `open` - so the facade holds inbound events back until the handler has
 * committed, then fires `open` and replays them in order; nothing is lost. The
 * handler receives a filled-in {@linkcode DeminoServeInfo} (`remoteAddr`,
 * `upgradeWebSocket`, `raw`) and `serve()` returns the shared
 * {@linkcode ServeHandle}.
 *
 * This is the only module in `src/` allowed to say `Bun.` at runtime, and even
 * here the slice of the global it uses is typed locally, so the file compiles
 * without `bun-types`.
 *
 * @example
 * ```ts
 * import { demino } from "@marianmeres/demino";
 * import { serve } from "@marianmeres/demino/bun";
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
// `Bun` - typed locally (the slice this adapter drives), so the module checks
// under a plain `tsc` run without `bun-types`
// ---------------------------------------------------------------------------

/** `Bun.SocketAddress` as `server.requestIP()` returns it. */
interface BunSocketAddress {
	address: string;
	family: "IPv4" | "IPv6";
	port: number;
}

/** `Bun.ServerWebSocket<T>` as the facade drives it. */
interface BunServerWebSocket<T> {
	/** The per-connection payload passed to `server.upgrade(req, { data })`. */
	readonly data: T;
	readonly readyState: number;
	/** How binary frames reach `websocket.message` (Bun's default is `"nodebuffer"`). */
	binaryType: "nodebuffer" | "arraybuffer" | "uint8array";
	/** Bytes sent, `-1` when queued by backpressure, `0` when dropped (socket closed). */
	send(data: string | BufferSource | Blob): number;
	close(code?: number, reason?: string): void;
	getBufferedAmount(): number;
}

/** `Bun.WebSocketHandler<T>`: the server-level event object. */
interface BunWebSocketHandlers<T> {
	open?(ws: BunServerWebSocket<T>): void;
	message(
		ws: BunServerWebSocket<T>,
		message: string | ArrayBuffer | ArrayBufferView,
	): void;
	close?(ws: BunServerWebSocket<T>, code: number, reason: string): void;
}

/** `Bun.Server` as this adapter reads it. */
interface BunServer {
	readonly hostname: string;
	readonly port: number;
	requestIP(req: Request): BunSocketAddress | null;
	/** `false` when the request is not a WebSocket handshake. */
	upgrade(
		req: Request,
		options?: { data?: unknown; headers?: Record<string, string> },
	): boolean;
	/**
	 * `false`: stop accepting, resolve once in-flight requests and open
	 * WebSockets are gone. `true`: close everything now (open WebSockets get a
	 * 1006). A pending graceful stop resolves once a forced one runs.
	 */
	stop(closeActiveConnections?: boolean): Promise<void>;
	ref(): void;
	unref(): void;
}

/**
 * The slice of the `Bun` global this adapter uses, typed locally so the module
 * type-checks under a plain `tsc` run without `bun-types`.
 */
interface BunRuntime {
	serve(options: {
		port: number;
		hostname: string;
		fetch(
			req: Request,
			server: BunServer,
		): Response | undefined | Promise<Response | undefined>;
		websocket: BunWebSocketHandlers<BunSocket>;
		error(error: Error): Response | Promise<Response>;
	}): BunServer;
}

const B = (globalThis as unknown as { Bun?: BunRuntime }).Bun;

// ---------------------------------------------------------------------------
// per-socket facade
// ---------------------------------------------------------------------------

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

type BunSocketBinaryType = "blob" | "arraybuffer";

/** An inbound event held back until the handler has committed the upgrade. */
type Inbound =
	| { type: "message"; data: string | ArrayBuffer }
	| { type: "close"; code: number; reason: string };

/**
 * Close-frame validation for a server-role socket: `1000`, `1001`-`1014`
 * except `1004`-`1006`, or `3000`-`4999`; reason at most 123 UTF-8 bytes. The
 * same set `ws` accepts (a client-role socket would only allow `1000` and
 * `3000`-`4999`). Throws the `DOMException`s the standard `close()` throws, so
 * a caller's code-less fallback (see the proxy tunnel) keeps working.
 */
function assertCloseArgs(code: number | undefined, reason: string | undefined): void {
	if (
		code !== undefined &&
		!(
			(code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 &&
				code !== 1006) ||
			(code >= 3000 && code <= 4999)
		)
	) {
		throw new DOMException(
			`The close code must be 1000, 1001-1014 (not 1004-1006) or 3000-4999, got ${code}`,
			"InvalidAccessError",
		);
	}
	if (reason !== undefined && new TextEncoder().encode(reason).byteLength > 123) {
		throw new DOMException(
			"The close reason must not be greater than 123 UTF-8 bytes",
			"SyntaxError",
		);
	}
}

/** A binary frame as a standalone `ArrayBuffer` (a view may alias a shared pool). */
function toArrayBuffer(data: ArrayBuffer | ArrayBufferView): ArrayBuffer {
	if (data instanceof ArrayBuffer) return data;
	return data.buffer.slice(
		data.byteOffset,
		data.byteOffset + data.byteLength,
	) as ArrayBuffer;
}

/**
 * Per-connection facade that presents one upgraded Bun connection as a
 * standard `WebSocket` (the members a handler, and the proxy tunnel, use).
 *
 * Lifecycle: created by `info.upgradeWebSocket` (CONNECTING); attached to
 * Bun's `ServerWebSocket` when `websocket.open` fires (synchronously inside
 * `server.upgrade()` on Bun 1.4); committed when the handler has returned the
 * 101. `open` fires once both have happened, and inbound events that arrived
 * in between are replayed then, in order. Outbound `send()`s before the
 * attach are queued and flushed on it.
 *
 * Adapter-internal: handlers only ever see it typed as `WebSocket`.
 */
class BunSocket extends EventTarget {
	static readonly CONNECTING = CONNECTING;
	static readonly OPEN = OPEN;
	static readonly CLOSING = CLOSING;
	static readonly CLOSED = CLOSED;
	readonly CONNECTING = CONNECTING;
	readonly OPEN = OPEN;
	readonly CLOSING = CLOSING;
	readonly CLOSED = CLOSED;

	/** The upgraded request's URL (`ws:` scheme), for parity with a client socket. */
	readonly url: string;
	/** The subprotocol the handler selected (echoed in `Sec-WebSocket-Protocol`). */
	readonly protocol: string;
	/** Bun negotiates no extensions. */
	readonly extensions = "";
	/**
	 * How binary frames reach `onmessage`. `"arraybuffer"` by default - the
	 * deterministic choice of the standard API (same as the Node adapter).
	 */
	binaryType: BunSocketBinaryType = "arraybuffer";

	#state = CONNECTING;
	#ws?: BunServerWebSocket<BunSocket>;
	#committed = false;
	#draining = false;
	/** `send()`s made before Bun's `open` attached the real socket. */
	#outbox: (string | BufferSource | Blob)[] = [];
	/** `close()` made before the attach; applied on it. */
	#pendingClose?: { code?: number; reason?: string };
	/** Inbound events, held until the handler has committed (see `#drain`). */
	#inbox: Inbound[] = [];

	#onopen: ((ev: Event) => void) | null = null;
	#onmessage: ((ev: MessageEvent) => void) | null = null;
	#onclose: ((ev: CloseEvent) => void) | null = null;
	#onerror: ((ev: Event) => void) | null = null;
	/** The `on*` handlers as registered listeners, so `dispatchEvent` runs them. */
	#listeners = new Map<string, EventListener>();

	constructor(url: string, protocol: string) {
		super();
		this.url = url;
		this.protocol = protocol;
	}

	get readyState(): number {
		return this.#state;
	}

	get bufferedAmount(): number {
		return this.#ws?.getBufferedAmount() ?? 0;
	}

	// --- event-handler attributes (IDL semantics: one listener slot per type) --

	#setHandler(type: string, fn: ((ev: never) => void) | null): void {
		const prev = this.#listeners.get(type);
		if (prev) this.removeEventListener(type, prev);
		this.#listeners.delete(type);
		if (fn) {
			const listener: EventListener = (ev) =>
				(fn as (ev: Event) => void).call(this, ev);
			this.addEventListener(type, listener);
			this.#listeners.set(type, listener);
		}
	}

	get onopen(): ((ev: Event) => void) | null {
		return this.#onopen;
	}
	set onopen(fn: ((ev: Event) => void) | null) {
		this.#onopen = fn;
		this.#setHandler("open", fn);
	}

	get onmessage(): ((ev: MessageEvent) => void) | null {
		return this.#onmessage;
	}
	set onmessage(fn: ((ev: MessageEvent) => void) | null) {
		this.#onmessage = fn;
		this.#setHandler("message", fn);
	}

	get onclose(): ((ev: CloseEvent) => void) | null {
		return this.#onclose;
	}
	set onclose(fn: ((ev: CloseEvent) => void) | null) {
		this.#onclose = fn;
		this.#setHandler("close", fn);
	}

	get onerror(): ((ev: Event) => void) | null {
		return this.#onerror;
	}
	set onerror(fn: ((ev: Event) => void) | null) {
		this.#onerror = fn;
		this.#setHandler("error", fn);
	}

	// --- the standard surface ----------------------------------------------------

	/**
	 * Sends a frame. Before Bun's `open` has attached the real socket the frame
	 * is queued and flushed on the attach (the 101 is already on the wire by
	 * then); after `close()` it is dropped, as the standard socket does.
	 */
	send(data: string | ArrayBufferLike | ArrayBufferView | Blob): void {
		if (this.#state >= CLOSING) return;
		const frame = data as string | BufferSource | Blob;
		if (this.#ws) this.#ws.send(frame);
		else this.#outbox.push(frame);
	}

	/**
	 * Starts the closing handshake (`CLOSING` at once, `close` event once Bun
	 * reports the socket gone). Throws like the standard `close()` on an invalid
	 * code or an over-long reason.
	 */
	close(code?: number, reason?: string): void {
		assertCloseArgs(code, reason);
		if (this.#state >= CLOSING) return;
		this.#state = CLOSING;
		if (this.#ws) this.#closeNative(this.#ws, code, reason);
		else this.#pendingClose = { code, reason };
	}

	#closeNative(
		ws: BunServerWebSocket<BunSocket>,
		code?: number,
		reason?: string,
	): void {
		if (code === undefined) ws.close();
		else ws.close(code, reason ?? "");
	}

	// --- adapter-internal hooks --------------------------------------------------

	/** `websocket.open`: the real socket exists; flush what was queued for it. */
	_attach(ws: BunServerWebSocket<BunSocket>): void {
		this.#ws = ws;
		ws.binaryType = "arraybuffer";
		for (const frame of this.#outbox) ws.send(frame);
		this.#outbox.length = 0;
		if (this.#pendingClose) {
			const { code, reason } = this.#pendingClose;
			this.#pendingClose = undefined;
			this.#closeNative(ws, code, reason);
		}
		this.#drain();
	}

	/** The handler returned the 101: fire `open`, replay what arrived meanwhile. */
	_commit(): void {
		this.#committed = true;
		this.#drain();
	}

	/**
	 * The handler upgraded but answered with something else: the 101 is already
	 * on the wire, so the only consistent outcome is a close (no `open`).
	 */
	_abandon(): void {
		this.#committed = true;
		this.close(1011, "Upgrade abandoned by the handler");
		this.#drain();
	}

	/** `websocket.message` */
	_message(data: string | ArrayBuffer | ArrayBufferView): void {
		this.#inbox.push({
			type: "message",
			data: typeof data === "string" ? data : toArrayBuffer(data),
		});
		this.#drain();
	}

	/** `websocket.close` */
	_close(code: number, reason: string): void {
		this.#inbox.push({ type: "close", code, reason });
		this.#drain();
	}

	/**
	 * Delivers held-back events once the socket is attached *and* the handler
	 * has committed: `open` first (unless `close()` already ran), then the
	 * inbox in order. Messages are only delivered while OPEN (standard
	 * semantics); a `1006` is an abnormal closure and fires `error` first.
	 * Re-entrancy-safe: a listener that closes the socket pushes onto the
	 * inbox, which the running loop picks up.
	 */
	#drain(): void {
		if (this.#draining || !this.#committed || !this.#ws) return;
		this.#draining = true;
		try {
			if (this.#state === CONNECTING) {
				this.#state = OPEN;
				this.dispatchEvent(new Event("open"));
			}
			while (this.#inbox.length) {
				const ev = this.#inbox.shift()!;
				if (ev.type === "message") {
					if (this.#state !== OPEN) continue;
					const data = this.binaryType === "blob" && typeof ev.data !== "string"
						? new Blob([ev.data])
						: ev.data;
					this.dispatchEvent(new MessageEvent("message", { data }));
				} else {
					this.#state = CLOSED;
					this.#ws = undefined;
					const wasClean = ev.code !== 1006;
					if (!wasClean) this.dispatchEvent(new Event("error"));
					this.dispatchEvent(
						new CloseEvent("close", {
							code: ev.code,
							reason: ev.reason,
							wasClean,
						}),
					);
				}
			}
		} finally {
			this.#draining = false;
		}
	}
}

/** The `101 Switching Protocols` a handler returns to commit an upgrade. Never written: Bun sent the real handshake inside `upgrade()`. */
function createUpgradedResponse(protocol: string): Response {
	const headers: Record<string, string> = {
		upgrade: "websocket",
		connection: "Upgrade",
	};
	if (protocol) headers["sec-websocket-protocol"] = protocol;
	return new Response(null, { status: 101, headers });
}

// ---------------------------------------------------------------------------
// serve()
// ---------------------------------------------------------------------------

/** IPv4-mapped IPv6 (`::ffff:10.0.0.1`, seen when listening on `::`) → plain IPv4, as Deno reports it. */
function normalizeMapped(ip: string): string {
	return ip.startsWith("::ffff:") && ip.includes(".") ? ip.slice(7) : ip;
}

/** Read at request start, while the request is alive. */
function remoteAddrOf(server: BunServer, req: Request): DeminoRemoteAddr | undefined {
	const ip = server.requestIP(req);
	if (!ip) return undefined;
	return { hostname: normalizeMapped(ip.address), port: ip.port, transport: "tcp" };
}

function defaultOnError(error: unknown): Response {
	console.error(error);
	return new Response("Internal Server Error", { status: 500 });
}

/**
 * Starts a Demino app (or any {@linkcode DeminoServeHandler}) on `Bun.serve`.
 *
 * Defaults follow `Deno.serve`: `0.0.0.0:8000`, `onListen` prints the listen
 * info (see `logListenInfo`). `info.upgradeWebSocket` is always present (pass
 * the request the handler received - Bun upgrades that object, not a copy);
 * its `idleTimeout` option is ignored (Bun's idle timeout is a server-wide
 * setting, left at Bun's default). `options.webSockets` is ignored as well.
 *
 * @param handler - The app or composed handler
 * @param options - Listen options (see {@linkcode ServeOptions})
 * @returns The running server's {@linkcode ServeHandle}
 * @throws Error when the `Bun` global is missing (use the `/deno` or `/node` adapter)
 *   or when the port cannot be bound (`code: "EADDRINUSE"`)
 */
// async on purpose: a synchronous throw from `Bun.serve` (e.g. port in use) must
// surface as a rejection, like every other adapter failure
// deno-lint-ignore require-await
export const serve: ServeFn = async (
	handler: DeminoServeHandler,
	options: ServeOptions = {},
): Promise<ServeHandle> => {
	if (!B) {
		throw new Error(
			"@marianmeres/demino/bun: `Bun` is not defined - use the /deno or /node adapter",
		);
	}

	const onError = options.onError ?? defaultOnError;
	const fail = async (error: unknown): Promise<Response> => {
		try {
			return await onError(error);
		} catch {
			return new Response("Internal Server Error", { status: 500 });
		}
	};

	/** Facades whose Bun socket is open: told goodbye (1001) on graceful shutdown. */
	const sockets = new Set<BunSocket>();

	const server = B.serve({
		port: options.port ?? 8000,
		hostname: options.hostname ?? "0.0.0.0",

		async fetch(req, srv) {
			let upgraded: { socket: BunSocket; response: Response } | undefined;

			const upgradeWebSocket: DeminoUpgradeWebSocket = (upgradeReq, opts) => {
				if (upgraded) throw new TypeError("upgradeWebSocket: already upgraded");
				const protocol = opts?.protocol || "";
				const socket = new BunSocket(
					upgradeReq.url.replace(/^http/, "ws"),
					protocol,
				);
				// `websocket.open` fires inside this call on Bun 1.4 (the facade
				// copes with either ordering)
				const ok = srv.upgrade(upgradeReq, {
					data: socket,
					headers: protocol
						? { "sec-websocket-protocol": protocol }
						: undefined,
				});
				if (!ok) {
					// Deno parity: not a WebSocket handshake (or not the request
					// Bun handed over) is a `TypeError`, not a silent `false`
					throw new TypeError(
						`upgradeWebSocket: not an upgrade request (${upgradeReq.method} ${upgradeReq.url})`,
					);
				}
				const response = createUpgradedResponse(protocol);
				upgraded = { socket, response };
				return { socket: socket as unknown as WebSocket, response };
			};

			const info: DeminoServeInfo = {
				remoteAddr: remoteAddrOf(srv, req),
				upgradeWebSocket,
				raw: srv,
			};

			let response: Response;
			try {
				response = await handler(req, info);
			} catch (e) {
				response = await fail(e);
			}

			if (upgraded) {
				if (response === upgraded.response) upgraded.socket._commit();
				else upgraded.socket._abandon();
				// Bun's contract after a successful `upgrade()`: nothing to write
				return undefined;
			}
			return response;
		},

		websocket: {
			open: (ws) => {
				sockets.add(ws.data);
				ws.data._attach(ws);
			},
			message: (ws, data) => ws.data._message(data),
			close: (ws, code, reason) => {
				sockets.delete(ws.data);
				ws.data._close(code, reason);
			},
		},

		// Bun's own failures (the handler's are caught above)
		error: (e) => fail(e),
	});

	const listen: DeminoListenAddr = { hostname: server.hostname, port: server.port };

	const finished = Promise.withResolvers<void>();

	let closing: Promise<void> | undefined;
	const shutdown = (): Promise<void> => {
		closing ??= (async () => {
			// stop accepting; resolves once in-flight requests have completed
			const graceful = server.stop(false);
			// a WebSocket is not an in-flight request: say goodbye instead of waiting
			for (const s of sockets) s.close(1001, "Server shutting down");
			// a stuck request cannot hang `finished`: force after the grace period
			// (the pending graceful stop resolves once the forced one runs)
			const timer = setTimeout(() => server.stop(true), FORCE_CLOSE_MS);
			await graceful;
			clearTimeout(timer);
			finished.resolve();
		})();
		return closing;
	};

	// Deno.serve parity: aborting the signal closes the server and all of its
	// connections at once (graceful is `shutdown()`)
	const abort = () => {
		const forced = server.stop(true).then(() => finished.resolve());
		closing ??= forced;
	};
	if (options.signal?.aborted) abort();
	else options.signal?.addEventListener("abort", abort, { once: true });

	(options.onListen ?? logListenInfo)(listen);

	const handle: ServeHandle = {
		hostname: listen.hostname,
		port: listen.port,
		url: toUrl(listen),
		finished: finished.promise,
		shutdown,
		ref: () => server.ref(),
		unref: () => server.unref(),
	};

	return handle;
};
