/**
 * WebSocket tunneling support for the proxy middleware. Internal module —
 * consumed by `proxy()` (see `ProxyOptions.webSockets`), not exported publicly.
 * @module
 */

import { TimeoutError } from "@marianmeres/midware";
import { HTTP_ERROR } from "@marianmeres/http-utils";

/**
 * Headers that must never be forwarded on the upstream WebSocket dial: the
 * client implementation derives `host` from the URL and generates its own
 * handshake (`sec-websocket-key`/`-version`/`-extensions`); client-offered
 * subprotocols travel via the constructor `protocols` option instead of the
 * raw header. Stripped AFTER `transformRequestHeaders`, so a transform cannot
 * corrupt the dial handshake either.
 */
const WS_INTERNAL_HEADERS = [
	"host",
	"sec-websocket-key",
	"sec-websocket-version",
	"sec-websocket-extensions",
	"sec-websocket-protocol",
] as const;

/**
 * Is this request a well-formed WebSocket upgrade — strict enough that
 * `Deno.upgradeWebSocket` is guaranteed to accept it? A malformed upgrade
 * (missing key, wrong version, non-GET) intentionally returns `false` and
 * falls through to the regular HTTP proxy path (the pre-WebSocket behavior).
 */
export function isWebSocketUpgradeRequest(req: Request): boolean {
	if (req.method !== "GET") return false;
	const containsToken = (headerValue: string | null, token: string) =>
		(headerValue ?? "")
			.split(",")
			.some((v) => v.trim().toLowerCase() === token);
	return (
		containsToken(req.headers.get("upgrade"), "websocket") &&
		containsToken(req.headers.get("connection"), "upgrade") &&
		!!req.headers.get("sec-websocket-key") &&
		req.headers.get("sec-websocket-version") === "13"
	);
}

/** Options consumed by {@link proxyWebSocket}. */
export interface ProxyWebSocketOptions {
	/** Upstream HANDSHAKE timeout in ms (`0` disables). Never bounds the tunnel lifetime. */
	timeout: number;
}

/**
 * Tunnels a WebSocket upgrade request to `targetUrl`.
 *
 * The upstream connection is dialed FIRST and the client is upgraded only
 * after the upstream handshake succeeds — so a failed dial is thrown (and
 * surfaces as a regular HTTP error response: 502/504/`onError`) instead of
 * upgrading the client and immediately dropping the socket.
 *
 * @param req - The (pre-validated, see {@link isWebSocketUpgradeRequest}) upgrade request
 * @param targetUrl - The policy-validated target (http(s) scheme is mapped to ws(s))
 * @param proxyHeaders - Fully built + transformed headers for the upstream dial
 *   (cookies/auth forwarding, `X-Forwarded-*`, hop counter, custom headers)
 * @param options - See {@link ProxyWebSocketOptions}
 * @returns The `101 Switching Protocols` response for the client
 */
export async function proxyWebSocket(
	req: Request,
	targetUrl: URL,
	proxyHeaders: Headers,
	options: ProxyWebSocketOptions,
): Promise<Response> {
	// http(s) -> ws(s); both families are "special" schemes, so the protocol
	// setter works. A target already given as ws(s) is passed through.
	const dialUrl = new URL(targetUrl);
	if (dialUrl.protocol === "http:") dialUrl.protocol = "ws:";
	else if (dialUrl.protocol === "https:") dialUrl.protocol = "wss:";

	// Client-offered subprotocols are forwarded via the constructor option
	// (the raw header is stripped below), so negotiation happens end-to-end:
	// the upstream's pick is mirrored back on the client upgrade.
	const protocols = (req.headers.get("sec-websocket-protocol") ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);

	const dialHeaders = new Headers(proxyHeaders);
	WS_INTERNAL_HEADERS.forEach((h) => dialHeaders.delete(h));

	const upstream = await dialUpstream(
		dialUrl,
		protocols,
		dialHeaders,
		options.timeout,
	);

	let client: WebSocket;
	let response: Response;
	try {
		({ socket: client, response } = Deno.upgradeWebSocket(req, {
			// mirror the upstream-negotiated subprotocol (empty string = none)
			protocol: upstream.protocol || undefined,
		}));
	} catch (e) {
		// `isWebSocketUpgradeRequest` makes this unreachable in practice, but if
		// the client upgrade ever fails the upstream leg must not leak
		closeQuietly(upstream);
		throw e;
	}

	pump(client, upstream);
	return response;
}

/**
 * Opens the upstream WebSocket and resolves once the handshake completes.
 * Rejects with `TimeoutError` (-> 504) when the handshake exceeds `timeout`,
 * or `NetworkError` (-> 502) when the upstream refuses/fails the connection.
 */
function dialUpstream(
	url: URL,
	protocols: string[],
	headers: Headers,
	timeout: number,
): Promise<WebSocket> {
	return new Promise<WebSocket>((resolve, reject) => {
		// The `{ protocols, headers }` options bag is a (stable) Deno extension
		// to the WebSocket constructor — it is what makes cookie/authorization
		// forwarding and the hop-counter loop guard possible on this leg.
		const ws = new WebSocket(url, {
			protocols: protocols.length ? protocols : undefined,
			headers,
		});

		let settled = false;
		let tid: ReturnType<typeof setTimeout> | undefined;
		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(tid);
			fn();
		};
		const fail = (err: Error) =>
			settle(() => {
				closeQuietly(ws);
				reject(err);
			});

		if (timeout) {
			tid = setTimeout(
				() => fail(new TimeoutError(`Upstream WebSocket handshake timed out`)),
				timeout,
			);
		}

		ws.onopen = () => settle(() => resolve(ws));
		ws.onerror = (e) => {
			const detail = (e as ErrorEvent)?.message || "connection failed";
			fail(
				new HTTP_ERROR.NetworkError(
					`Upstream WebSocket unreachable (${detail})`,
				),
			);
		};
		// close-without-error during the handshake (e.g. upstream accepted TCP
		// then hung up) — `onerror` usually fires first and wins via `settle`
		ws.onclose = () =>
			fail(
				new HTTP_ERROR.NetworkError(
					"Upstream WebSocket closed during handshake",
				),
			);
	});
}

/**
 * Wires the two open legs of the tunnel together: messages are forwarded in
 * both directions, close code + reason are propagated in both directions.
 */
function pump(client: WebSocket, upstream: WebSocket): void {
	// deterministic binary forwarding (default would be Blob on some legs)
	client.binaryType = "arraybuffer";
	upstream.binaryType = "arraybuffer";

	// The upstream leg is already open; the client leg completes its 101
	// handshake asynchronously (after the response is returned). Frames the
	// upstream sends inside that tiny window are buffered, then flushed on
	// client open — the window is bounded by the local handshake, so the
	// backlog cannot grow meaningfully.
	let clientOpen = false;
	const backlog: (string | ArrayBuffer)[] = [];

	const forward = (to: WebSocket, data: string | ArrayBuffer) => {
		// a send can race the peer closing; close propagation handles the rest
		try {
			to.send(data);
		} catch {
			/* ignore */
		}
	};

	client.onopen = () => {
		clientOpen = true;
		backlog.forEach((data) => forward(client, data));
		backlog.length = 0;
	};
	client.onmessage = (e) => forward(upstream, e.data);
	upstream.onmessage = (e) => {
		if (clientOpen) forward(client, e.data);
		else backlog.push(e.data);
	};

	client.onclose = (e) => closeQuietly(upstream, e.code, e.reason);
	upstream.onclose = (e) => closeQuietly(client, e.code, e.reason);

	// an abnormal close fires `error` then `close` — the close handlers above
	// do the propagation; these only swallow the redundant error events
	client.onerror = () => {};
	upstream.onerror = () => {};
}

/**
 * Closes a socket propagating `code`/`reason` when the WebSocket API permits
 * it. Reserved codes (1005/1006/1015), codes outside the client-role range
 * (client sockets only accept 1000 and 3000-4999), or an over-long reason
 * make `close(code, reason)` throw — those fall back to a code-less close
 * rather than leaving the leg dangling.
 */
function closeQuietly(sock: WebSocket, code?: number, reason?: string): void {
	if (
		sock.readyState === WebSocket.CLOSED ||
		sock.readyState === WebSocket.CLOSING
	) {
		return;
	}
	try {
		sock.close(code, reason);
	} catch {
		try {
			sock.close();
		} catch {
			/* ignore */
		}
	}
}
