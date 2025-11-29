import { withTimeout } from "@marianmeres/midware";
import type { DeminoContext, DeminoHandler } from "../demino.ts";

/**
 * Creates a proxy middleware that forwards requests to a different server.
 *
 * Automatically handles request forwarding, header management, and response streaming.
 * Supports both static and dynamic target URLs.
 *
 * Features:
 * - Preserves request method and body
 * - Sets X-Forwarded-* headers automatically
 * - Supports wildcard paths with automatic pathname appending
 * - Configurable timeout (default: 60 seconds)
 * - Prevents self-proxying
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
 * @example With custom timeout
 * ```ts
 * app.get("/slow-api/*", proxy("https://slow-backend.com/*", {
 *   timeout: 120_000 // 2 minutes
 * }));
 * ```
 *
 * @example Full request proxy
 * ```ts
 * // Preserves query params, headers, and body
 * app.all("/proxy/*", proxy("https://api.example.com/*"));
 * ```
 */
export function proxy(
	target:
		| string
		| ((req: Request, ctx: DeminoContext) => string | Promise<string>),
	options?: Partial<{
		/** Timeout in milliseconds for the proxy request (default: 60000) */
		timeout: number;
	}>,
): DeminoHandler {
	const { timeout = 60_000 } = options ?? {};
	if (isNaN(timeout) || timeout < 0) {
		throw new TypeError(`Invalid timeout value '${timeout}'`);
	}

	const _proxy: DeminoHandler = async (req, _i, ctx) => {
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
				`Invalid target parameter, expecting string or a function`,
			);
		}

		const targetUrl = new URL(_target, url);

		// Prevent proxying to ourselves
		if (targetUrl.toString() === url.toString()) {
			throw new Error("Cannot proxy to self");
		}

		//
		const proxyHeaders = new Headers(req.headers);
		proxyHeaders.set("host", targetUrl.host);
		const origin = req.headers.get("origin");
		if (origin) proxyHeaders.set("origin", origin);

		// Remove headers that might cause issues
		// prettier-ignore
		["connection", "keep-alive", "transfer-encoding", "upgrade", "expect"].forEach(
			(name) => proxyHeaders.delete(name),
		);

		// X-Forwarded-* headers
		proxyHeaders.set("x-forwarded-host", url.host);
		proxyHeaders.set("x-forwarded-proto", url.protocol.replace(":", ""));
		proxyHeaders.set("x-forwarded-for", ctx.ip);

		//
		const proxyReq = new Request(targetUrl, {
			method: req.method,
			headers: proxyHeaders,
			body: req.body,
			redirect: "follow",
			cache: "no-store", // hm...
		});

		const resp = await fetch(proxyReq);

		// Create response with cleaned headers
		const respHeaders = new Headers(resp.headers);
		// prettier-ignore
		["connection", "keep-alive", "transfer-encoding"].forEach(
			(name) => respHeaders.delete(name),
		);

		//
		const r = new Response(resp.body, {
			status: resp.status,
			statusText: resp.statusText,
			headers: respHeaders,
		});

		return r;
	};

	return timeout
		? withTimeout<DeminoHandler>(_proxy, timeout, "Proxy request timed out")
		: _proxy;
}
