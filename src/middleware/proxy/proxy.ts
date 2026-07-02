import { TimeoutError } from "@marianmeres/midware";
import {
	createHttpError,
	fetchOrThrow,
	HTTP_ERROR,
	HTTP_STATUS,
} from "@marianmeres/http-utils";
import type { DeminoContext, DeminoHandler } from "../../demino.ts";
import {
	isHostAllowed,
	isPrivateHost,
	MAX_PROXY_HOPS,
	PROXY_HOPS_HEADER,
	PROXY_REQUEST_REMOVE_HEADERS,
	PROXY_RESPONSE_REMOVE_HEADERS,
} from "./utils.ts";
import { isWebSocketUpgradeRequest, proxyWebSocket } from "./websocket.ts";

export interface ProxyOptions {
	/** Timeout in milliseconds for the proxy request (default: 60000) */
	timeout: number;
	/**
	 * Maximum number of upstream redirects to follow (default: 5). Each hop is
	 * re-validated against the SSRF / `allowedHosts` policy before it is fetched,
	 * so a permitted upstream cannot bounce the proxy into an internal host.
	 * Exceeding the limit surfaces as an error (mapped to a 500). Set to `0` to
	 * reject any upstream redirect. A body-preserving redirect (307/308) whose
	 * one-shot request body cannot be replayed is handed back to the client
	 * unfollowed rather than re-issued with an altered request.
	 */
	maxRedirects: number;
	/** Enable SSRF protection by blocking private/internal IPs (default: false) */
	preventSSRF: boolean;
	/** Whitelist of allowed target hosts. Supports wildcards (e.g., "*.example.com") */
	allowedHosts: string[];
	/**
	 * Enable transparent WebSocket proxying (default: true). A well-formed
	 * WebSocket upgrade request (GET + `Upgrade: websocket` + `Sec-WebSocket-Key`
	 * + version 13) is tunneled to the upstream instead of being forwarded as a
	 * plain — and therefore never upgradable — GET. Set to `false` to restore
	 * the pre-1.17.0 behavior (upgrade headers stripped, forwarded as HTTP).
	 * See the `proxy()` docs for tunnel semantics and which options do not
	 * apply to tunnels.
	 */
	webSockets: boolean;
	/** Custom headers to add to the proxy request */
	headers: Record<string, string>;
	/** Function to transform request headers before proxying */
	transformRequestHeaders: (
		headers: Headers,
		req: Request,
		ctx: DeminoContext,
	) => Headers | Promise<Headers>;
	/** Function to transform response headers before returning */
	transformResponseHeaders: (
		headers: Headers,
		resp: Response,
	) => Headers | Promise<Headers>;
	/** Function to transform response body before returning */
	transformResponseBody: (
		body: BodyInit | null,
		resp: Response,
	) => BodyInit | null | Promise<BodyInit | null>;
	/** Cache strategy for the proxy request (default: "no-store") */
	cache: RequestCache;
	/** Error handler for failed proxy requests */
	onError: (
		error: Error,
		req: Request,
		ctx: DeminoContext,
	) => Response | Promise<Response>;
	/** Additional headers to remove from proxy requests */
	removeRequestHeaders: string[];
	/** Additional headers to remove from proxy responses */
	removeResponseHeaders: string[];
}

/**
 * Creates a proxy middleware that forwards requests to a different server.
 *
 * Automatically handles request forwarding, header management, and response streaming.
 * Supports both static and dynamic target URLs.
 *
 * Features:
 * - Preserves request method and body
 * - Sets X-Forwarded-* headers automatically (including X-Forwarded-Port, X-Real-IP)
 * - Supports wildcard paths with automatic pathname appending
 * - Configurable timeout (default: 60 seconds)
 * - Prevents self-proxying
 * - Optional SSRF protection
 * - Host whitelisting support
 * - Request/response header transformation
 * - Response body transformation
 * - Configurable caching strategy
 * - Custom error handling
 * - Maps upstream failures to gateway statuses (502 unreachable, 504 timeout)
 * - Transparent WebSocket proxying (see below)
 *
 * WebSocket proxying (since 1.17.0, on by default — `webSockets: false` to
 * disable): a well-formed WebSocket upgrade request is tunneled to the
 * upstream (`http(s)` targets are dialed as `ws(s)`). The upstream is dialed
 * FIRST — the full target policy (self-proxy / SSRF / `allowedHosts`) applies,
 * request headers (cookies, authorization, custom `headers`,
 * `transformRequestHeaders`, `X-Forwarded-*`, hop-counter loop guard) are
 * forwarded, and subprotocols are negotiated end-to-end — and the client is
 * upgraded only after the upstream handshake succeeds, so a failed dial
 * surfaces as a regular HTTP error (502 unreachable, 504 handshake timeout,
 * `onError`), not a silently dropped socket. Close code + reason propagate in
 * both directions. `timeout` bounds only the upstream handshake, never the
 * tunnel lifetime. Not applicable to tunnels: `maxRedirects` (upstream
 * WebSocket redirects are not followed), `cache`, `transformResponseHeaders`,
 * `transformResponseBody` (the 101 response is runtime-generated).
 *
 * @param target - Target URL (string or function). Strings ending with `/*` append the request pathname.
 * @param options - Optional configuration
 * @returns Middleware handler that proxies the request
 *
 * @example Static proxy with wildcard
 * ```ts
 * import { proxy } from "@marianmeres/demino";
 *
 * // GET /api/users -> GET https://backend.example.com/api/users
 * app.get("/api/*", proxy("https://backend.example.com/*"));
 * ```
 *
 * @example WebSocket proxying (enabled by default)
 * ```ts
 * // ws://this-app/ws/chat -> wss://backend.example.com/ws/chat
 * app.get("/ws/*", proxy("https://backend.example.com/*"));
 * ```
 *
 * @example Dynamic proxy using route params
 * ```ts
 * app.get("/search/[keyword]", proxy((req, ctx) =>
 *   `https://google.com/?q=${ctx.params.keyword}`
 * ));
 * ```
 *
 * @example With SSRF protection and host whitelisting
 * ```ts
 * app.get("/api/*", proxy("https://backend.example.com/*", {
 *   preventSSRF: true,
 *   allowedHosts: ["backend.example.com", "*.trusted.com"]
 * }));
 * ```
 *
 * @example With custom headers
 * ```ts
 * app.get("/api/*", proxy("https://api.example.com/*", {
 *   headers: {
 *     "X-API-Key": "secret",
 *     "X-Custom-Header": "value"
 *   }
 * }));
 * ```
 *
 * @example With header transformation
 * ```ts
 * app.get("/api/*", proxy("https://api.example.com/*", {
 *   transformRequestHeaders: (headers) => {
 *     headers.set("Authorization", "Bearer " + getToken());
 *     return headers;
 *   }
 * }));
 * ```
 *
 * @example With custom error handling
 * ```ts
 * app.get("/api/*", proxy("https://api.example.com/*", {
 *   onError: (error, req, ctx) => {
 *     console.error("Proxy error:", error);
 *     return new Response("Service unavailable", { status: 503 });
 *   }
 * }));
 * ```
 */
export function proxy(
	target:
		| string
		| ((req: Request, ctx: DeminoContext) => string | Promise<string>),
	options?: Partial<ProxyOptions>,
): DeminoHandler {
	const {
		timeout = 60_000,
		maxRedirects = 5,
		preventSSRF = false,
		allowedHosts,
		webSockets = true,
		headers: customHeaders,
		transformRequestHeaders,
		transformResponseHeaders,
		transformResponseBody,
		cache = "no-store",
		onError,
		removeRequestHeaders = [],
		removeResponseHeaders = [],
	} = options ?? {};

	if (isNaN(timeout) || timeout < 0) {
		throw new TypeError(`Invalid timeout value '${timeout}'`);
	}
	if (!Number.isInteger(maxRedirects) || maxRedirects < 0) {
		throw new TypeError(
			`Invalid maxRedirects value '${maxRedirects}' (expecting a non-negative integer)`,
		);
	}

	// Applies the full target policy (self-proxy, SSRF, host allowlist). Re-run for
	// EVERY hop — the initial target and each redirect destination — so a permitted
	// upstream cannot redirect the proxy into an internal/blocked host.
	const assertTargetAllowed = (targetUrl: URL, reqUrl: URL) => {
		if (targetUrl.toString() === reqUrl.toString()) {
			throw new Error("Cannot proxy to self");
		}
		if (preventSSRF && isPrivateHost(targetUrl.hostname)) {
			throw new Error(
				`SSRF protection: Cannot proxy to private host '${targetUrl.hostname}'`,
			);
		}
		if (!isHostAllowed(targetUrl.hostname, allowedHosts)) {
			throw new Error(
				`Host '${targetUrl.hostname}' is not in the allowed hosts list`,
			);
		}
	};

	// Resolves the effective target URL for this request (string targets get
	// the `/*` pathname + search auto-processing, function targets are manual).
	const resolveTarget = async (
		req: Request,
		ctx: DeminoContext,
		url: URL,
	): Promise<URL> => {
		let _target: URL | string;

		// plain string (do some auto processing)
		if (typeof target === "string") {
			_target = new URL(target, url);
			// FEATURE: if our target ends with "/*" append the full req.url.pathname to it
			if (_target.pathname.endsWith("/*")) {
				_target.pathname = _target.pathname.slice(0, -2) + url.pathname;
			}
			// also reuse search query if not exists
			if (!_target.search) _target.search = url.search;
		} // but not with functions, they are fully manual
		else if (typeof target === "function") {
			_target = await target(req, ctx);
			if (typeof _target !== "string" || !_target) {
				throw new TypeError(`Invalid target, expecting valid url`);
			}
		} else {
			throw new TypeError(
				`Invalid target parameter, expecting string or a function`,
			);
		}

		return new URL(_target, url);
	};

	// Builds the outgoing proxy headers (shared by the HTTP path and the
	// WebSocket dial): hop-counter loop guard, header removal list,
	// X-Forwarded-*, custom headers, `transformRequestHeaders`.
	const buildProxyHeaders = async (
		req: Request,
		ctx: DeminoContext,
		targetUrl: URL,
	): Promise<Headers> => {
		// Loop guard. The exact self-URL check in `assertTargetAllowed` only
		// catches an identical target; a loop through a slightly different URL
		// (trailing slash, another proxy that bounces back, …) would recurse.
		// Carry a hop counter so a chain that keeps re-entering a demino proxy
		// is cut off instead of exhausting connections. It rides on the request
		// headers, so it survives self- and cross-proxy hops.
		const hops = Number(req.headers.get(PROXY_HOPS_HEADER) ?? 0) || 0;
		if (hops >= MAX_PROXY_HOPS) {
			throw new Error(
				`Proxy loop detected (exceeded ${MAX_PROXY_HOPS} hops)`,
			);
		}

		// Build proxy headers
		let proxyHeaders = new Headers(req.headers);
		proxyHeaders.set("host", targetUrl.host);
		proxyHeaders.set(PROXY_HOPS_HEADER, String(hops + 1));
		const origin = req.headers.get("origin");
		if (origin) proxyHeaders.set("origin", origin);

		// Remove standard problematic headers
		[...PROXY_REQUEST_REMOVE_HEADERS, ...removeRequestHeaders].forEach(
			(name) => proxyHeaders.delete(name),
		);

		// X-Forwarded-* headers. Derive scheme/host/port from `ctx.url`
		// (proxy-aware) rather than the raw `url` so that when THIS app is
		// itself behind a trusted proxy (`trustProxy`), the chained-downstream
		// request advertises the original client-facing scheme/host instead of
		// the internal proxy->app hop. With `trustProxy` off, `ctx.url` ===
		// `new URL(req.url)`, so this is byte-identical to the previous behavior.
		proxyHeaders.set("x-forwarded-host", ctx.url.host);
		proxyHeaders.set("x-forwarded-proto", ctx.url.protocol.replace(":", ""));
		proxyHeaders.set("x-forwarded-for", ctx.ip);
		proxyHeaders.set(
			"x-forwarded-port",
			ctx.url.port || (ctx.url.protocol === "https:" ? "443" : "80"),
		);
		proxyHeaders.set("x-real-ip", ctx.ip);

		// Add custom headers
		if (customHeaders) {
			for (const [key, value] of Object.entries(customHeaders)) {
				proxyHeaders.set(key, value);
			}
		}

		// Apply header transformation if provided
		if (transformRequestHeaders) {
			proxyHeaders = await transformRequestHeaders(proxyHeaders, req, ctx);
		}

		return proxyHeaders;
	};

	const _proxy: DeminoHandler = async (req, _i, ctx) => {
		try {
			// WebSocket upgrade? Tunnel it on a dedicated path: the upstream is
			// dialed FIRST (same target policy, same outgoing headers) and the
			// client is upgraded only once the upstream handshake succeeded — so
			// handshake failures keep plain HTTP error semantics (502/504/
			// `onError`). NOT wrapped in the AbortController timeout flow below:
			// `timeout` must bound the handshake only, never the tunnel lifetime
			// (a WebSocket legitimately outlives any request timeout).
			if (webSockets && isWebSocketUpgradeRequest(req)) {
				const url = new URL(req.url);
				const targetUrl = await resolveTarget(req, ctx, url);
				assertTargetAllowed(targetUrl, url);
				const proxyHeaders = await buildProxyHeaders(req, ctx, targetUrl);
				return await proxyWebSocket(req, targetUrl, proxyHeaders, { timeout });
			}

			const doProxy = async (signal?: AbortSignal) => {
				const url = new URL(req.url);
				const targetUrl = await resolveTarget(req, ctx, url);

				// Validate the initial target (self-proxy, SSRF, host allowlist).
				// Redirect hops below are re-validated with the same policy.
				assertTargetAllowed(targetUrl, url);

				const proxyHeaders = await buildProxyHeaders(req, ctx, targetUrl);

				// Turns a terminal upstream response into the cleaned, transformed
				// Response handed back to the client.
				const finalizeResponse = async (resp: Response): Promise<Response> => {
					let respHeaders = new Headers(resp.headers);
					[...PROXY_RESPONSE_REMOVE_HEADERS, ...removeResponseHeaders].forEach(
						(name) => respHeaders.delete(name),
					);

					// Apply response header transformation if provided
					if (transformResponseHeaders) {
						respHeaders = await transformResponseHeaders(respHeaders, resp);
					}

					// Apply response body transformation if provided
					let respBody: BodyInit | null = resp.body;
					if (transformResponseBody) {
						respBody = await transformResponseBody(respBody, resp);
						// Remove Content-Length header as the body length has changed
						respHeaders.delete("content-length");
					}

					return new Response(respBody, {
						status: resp.status,
						statusText: resp.statusText,
						headers: respHeaders,
					});
				};

				// Follow redirects MANUALLY so every hop is re-validated against the
				// SSRF / allowlist policy. fetch's own `redirect: "follow"` would skip
				// those checks, letting a permitted upstream bounce us into an internal
				// host. `req.body` is a one-shot stream: a body-preserving redirect
				// (307/308) we cannot replay is handed back to the client rather than
				// re-issued with an altered request (fail safe, never fail open).
				let currentUrl = targetUrl;
				let hopMethod = req.method;
				let hopBody: BodyInit | null | undefined = req.body;
				let hopHeaders = proxyHeaders;

				for (let hop = 0;; hop++) {
					const proxyReq = new Request(currentUrl, {
						method: hopMethod,
						headers: hopHeaders,
						body: hopBody,
						redirect: "manual",
						cache,
						signal,
					});

					// `fetchOrThrow` turns opaque transport failures (DNS, refused,
					// unreachable) into a typed `NetworkError` with the real reason,
					// while passing deliberate aborts/timeouts through untouched.
					const resp = await fetchOrThrow(proxyReq, undefined, "Upstream");

					const location = resp.headers.get("location");
					const isRedirect = resp.status >= 300 && resp.status < 400 &&
						resp.status !== 304 && !!location;
					if (!isRedirect) return await finalizeResponse(resp);

					if (hop >= maxRedirects) {
						await resp.body?.cancel();
						throw new Error(
							`Upstream exceeded the redirect limit (${maxRedirects})`,
						);
					}

					const nextUrl = new URL(location!, currentUrl);
					// Re-apply the FULL target policy to the redirect destination.
					assertTargetAllowed(nextUrl, url);

					// RFC 7231: 303 (and 301/302 for a non-GET/HEAD original, by
					// near-universal practice) switch to GET and drop the body;
					// 307/308 preserve method + body.
					const m = hopMethod.toUpperCase();
					const switchToGet = resp.status === 303 ||
						((resp.status === 301 || resp.status === 302) &&
							m !== "GET" && m !== "HEAD");

					if (!switchToGet && hopBody != null) {
						// Body-preserving redirect, but the one-shot body was already sent
						// and cannot be replayed — return the 3xx to the client instead.
						return await finalizeResponse(resp);
					}

					// discard the redirect response body before the next hop
					await resp.body?.cancel();

					const nextHeaders = new Headers(hopHeaders);
					nextHeaders.set("host", nextUrl.host);
					if (switchToGet) {
						hopMethod = "GET";
						["content-length", "content-type", "transfer-encoding"].forEach(
							(h) => nextHeaders.delete(h),
						);
					}
					hopBody = undefined;
					currentUrl = nextUrl;
					hopHeaders = nextHeaders;
				}
			};

			if (!timeout) {
				return await doProxy();
			}

			// Use AbortController to actually cancel the in-flight fetch on timeout
			// (unlike Promise.race, which leaves the fetch running in the background)
			const ac = new AbortController();
			const tid = setTimeout(() => ac.abort(), timeout);
			try {
				return await doProxy(ac.signal);
			} catch (e) {
				if (e instanceof DOMException && e.name === "AbortError") {
					throw new TimeoutError("Proxy request timed out");
				}
				throw e;
			} finally {
				clearTimeout(tid);
			}
		} catch (error) {
			// Custom error handler (if provided) receives the original, typed
			// error and takes full control of the response.
			if (onError) {
				return await onError(error as Error, req, ctx);
			}
			// Otherwise rethrow, mapping upstream failures to conventional
			// gateway statuses so they don't collapse into a generic 500.
			throw toGatewayError(error);
		}
	};

	return _proxy;
}

/**
 * Maps upstream proxy failures to conventional gateway statuses:
 * - transport failure (unreachable upstream) -> 502 Bad Gateway
 * - upstream timeout                          -> 504 Gateway Timeout
 *
 * Any other error (self-proxy, SSRF/host policy, misconfiguration) is left
 * untouched and surfaces with its own status (or demino's 500 fallback). The
 * original error is preserved as `cause`.
 */
function toGatewayError(error: unknown): unknown {
	if (error instanceof HTTP_ERROR.NetworkError) {
		return createHttpError(
			HTTP_STATUS.ERROR_SERVER.BAD_GATEWAY.CODE,
			error.message,
			null,
			error,
		);
	}
	if (error instanceof TimeoutError) {
		return createHttpError(
			HTTP_STATUS.ERROR_SERVER.GATEWAY_TIMEOUT.CODE,
			error.message,
			null,
			error,
		);
	}
	return error;
}
