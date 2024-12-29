import { withTimeout } from "@marianmeres/midware";
import type { DeminoContext, DeminoHandler } from "../demino.ts";

/**
 * Will create a proxy middleware which will proxy the current request to the specified
 * target in options.
 *
 * Target can be relative or absolute. If specified as a plain string, search query params
 * will be proxied as well.
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
export function proxy(options: {
	/** Either plain url string or a function resolving to one. */
	target:
		| string
		| ((req: Request, ctx: DeminoContext) => string | Promise<string>);
	/** If non zero number of ms is provided, will set the watch clock for the proxy
	 * request to complete. */
	timeout?: number;
}): DeminoHandler {
	const { timeout = 60_000 } = options ?? {};
	if (isNaN(timeout) || timeout < 0) {
		throw new TypeError(`Invalid timeout value '${timeout}'`);
	}

	const _proxy: DeminoHandler = async (req, _i, ctx) => {
		let { target } = options ?? {};
		const url = new URL(req.url);

		if (typeof target === "string") {
			// auto add search params to target if none exist
			const _tmp = new URL(target, url);
			if (!_tmp.search) target += url.search;
		} else if (typeof target === "function") {
			// no auto magic with functions
			target = await target(req, ctx);
		}

		if (typeof target !== "string" || !target) {
			throw new TypeError(`Invalid target, expecting valid url`);
		}

		const targetUrl = new URL(target, url);

		// Prevent proxying to ourselves
		if (targetUrl.toString() === url.toString()) {
			throw new Error("Cannot proxy to self");
		}

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

		const proxyReq = new Request(targetUrl, {
			method: req.method,
			headers: proxyHeaders,
			body: req.body,
			redirect: "follow",
			cache: "no-store",
		});

		// console.log(proxyReq);

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
