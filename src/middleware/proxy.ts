import { withTimeout } from "@marianmeres/midware";
import type { DeminoContext, DeminoHandler } from "../demino.ts";

/**
 * Will create a proxy middleware which will proxy the current request to the specified
 * target.
 *
 * Target can be relative or absolute. If specified as a plain string, search query params
 * will be appended automatically.
 *
 * Currently does NOT support websockets.
 *
 * @example
 * ```ts
 * app.get('/search', proxy({ target: 'https://google.com' }));
 * // or as a function for dynamic target
 * app.get(
 *     '/search/[keyword]',
 *     proxy({ target: (req, ctx) => `https://google.com/?q=${ctx.params.keyword}` })
 * );
 * ```
 */
export function proxy(
	/** Either plain url string or a function resolving to one. */
	target:
		| string
		| ((req: Request, ctx: DeminoContext) => string | Promise<string>),
	options?: Partial<{
		/** If non zero number of ms is provided, will set the watch clock for the proxy
		 * request to complete. */
		timeout: number;
	}>
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
		}
		// but not with functions, they are fully manual
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

		//
		const proxyHeaders = new Headers(req.headers);
		proxyHeaders.set("host", targetUrl.host);
		const origin = req.headers.get("origin");
		if (origin) proxyHeaders.set("origin", origin);

		// Remove headers that might cause issues
		// prettier-ignore
		["connection", "keep-alive", "transfer-encoding", "upgrade", "expect"].forEach(
			(name) => proxyHeaders.delete(name)
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
			(name) => respHeaders.delete(name)
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
