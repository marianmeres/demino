import { withTimeout } from "@marianmeres/midware";
import type { DeminoContext, DeminoHandler } from "../../demino.ts";
import {
	isHostAllowed,
	isPrivateHost,
	PROXY_REQUEST_REMOVE_HEADERS,
	PROXY_RESPONSE_REMOVE_HEADERS,
} from "./utils.ts";

export interface ProxyOptions {
	/** Timeout in milliseconds for the proxy request (default: 60000) */
	timeout: number;
	/** Enable SSRF protection by blocking private/internal IPs (default: false) */
	preventSSRF: boolean;
	/** Whitelist of allowed target hosts. Supports wildcards (e.g., "*.example.com") */
	allowedHosts: string[];
	/** Custom headers to add to the proxy request */
	headers: Record<string, string>;
	/** Function to transform request headers before proxying */
	transformRequestHeaders: (
		headers: Headers,
		req: Request,
		ctx: DeminoContext
	) => Headers | Promise<Headers>;
	/** Function to transform response headers before returning */
	transformResponseHeaders: (
		headers: Headers,
		resp: Response
	) => Headers | Promise<Headers>;
	/** Function to transform response body before returning */
	transformResponseBody: (
		body: BodyInit | null,
		resp: Response
	) => BodyInit | null | Promise<BodyInit | null>;
	/** Cache strategy for the proxy request (default: "no-store") */
	cache: RequestCache;
	/** Error handler for failed proxy requests */
	onError: (
		error: Error,
		req: Request,
		ctx: DeminoContext
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
 *
 * Note: Does NOT support WebSocket proxying.
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
	options?: Partial<ProxyOptions>
): DeminoHandler {
	const {
		timeout = 60_000,
		preventSSRF = false,
		allowedHosts,
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

	const _proxy: DeminoHandler = async (req, _i, ctx) => {
		try {
			const url = new URL(req.url);
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
					`Invalid target parameter, expecting string or a function`
				);
			}

			const targetUrl = new URL(_target, url);

			// Prevent proxying to ourselves
			if (targetUrl.toString() === url.toString()) {
				throw new Error("Cannot proxy to self");
			}

			// SSRF protection
			if (preventSSRF && isPrivateHost(targetUrl.hostname)) {
				throw new Error(
					`SSRF protection: Cannot proxy to private host '${targetUrl.hostname}'`
				);
			}

			// Host whitelist validation
			if (!isHostAllowed(targetUrl.hostname, allowedHosts)) {
				throw new Error(
					`Host '${targetUrl.hostname}' is not in the allowed hosts list`
				);
			}

			// Build proxy headers
			let proxyHeaders = new Headers(req.headers);
			proxyHeaders.set("host", targetUrl.host);
			const origin = req.headers.get("origin");
			if (origin) proxyHeaders.set("origin", origin);

			// Remove standard problematic headers
			[...PROXY_REQUEST_REMOVE_HEADERS, ...removeRequestHeaders].forEach(
				(name) => proxyHeaders.delete(name)
			);

			// X-Forwarded-* headers
			proxyHeaders.set("x-forwarded-host", url.host);
			proxyHeaders.set("x-forwarded-proto", url.protocol.replace(":", ""));
			proxyHeaders.set("x-forwarded-for", ctx.ip);
			proxyHeaders.set(
				"x-forwarded-port",
				url.port || (url.protocol === "https:" ? "443" : "80")
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

			// Create and execute proxy request
			const proxyReq = new Request(targetUrl, {
				method: req.method,
				headers: proxyHeaders,
				body: req.body,
				redirect: "follow",
				cache,
			});

			const resp = await fetch(proxyReq);

			// Create response with cleaned headers
			let respHeaders = new Headers(resp.headers);
			[...PROXY_RESPONSE_REMOVE_HEADERS, ...removeResponseHeaders].forEach(
				(name) => respHeaders.delete(name)
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

			const r = new Response(respBody, {
				status: resp.status,
				statusText: resp.statusText,
				headers: respHeaders,
			});

			return r;
		} catch (error) {
			// Use custom error handler if provided
			if (onError) {
				return await onError(error as Error, req, ctx);
			}
			// Otherwise rethrow
			throw error;
		}
	};

	return timeout
		? withTimeout<DeminoHandler>(_proxy, timeout, "Proxy request timed out")
		: _proxy;
}
