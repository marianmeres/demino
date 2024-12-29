import type { DeminoContext, DeminoHandler } from "../demino.ts";
import { withTimeout } from "@marianmeres/midware";

export function proxy(options: {
	target: string | ((req: Request) => string | Promise<string>);
	timeout?: number;
}): DeminoHandler {
	let { target, timeout = 10_000 } = options ?? {};

	if (isNaN(timeout) || timeout <= 0) {
		throw new TypeError(`Invalid timeout value '${timeout}'`);
	}

	const _proxy = async (
		req: Request,
		_i: Deno.ServeHandlerInfo,
		ctx: DeminoContext
	) => {
		const url = new URL(req.url);

		if (typeof target === "string") {
			// auto add search params to target if none exist
			const _tmp = new URL(target, url);
			if (!_tmp.search) target += url.search;
		} else if (typeof target === "function") {
			// no auto magic with functions
			target = await target(req);
		}

		if (typeof target !== "string" || !target) {
			throw new TypeError(`Invalid target, expecting valid url`);
		}

		const targetUrl = new URL(target, url);

		// Prevent proxying to ourselves
		if (targetUrl.toString() === url.toString()) {
			return new Error("Cannot proxy to self");
		}

		const proxyHdrs = new Headers(req.headers);

		// Update host header to match target URL
		proxyHdrs.set("host", targetUrl.host);

		// Remove headers that might cause issues
		proxyHdrs.delete("connection");
		proxyHdrs.delete("keep-alive");
		proxyHdrs.delete("transfer-encoding");
		proxyHdrs.delete("upgrade");
		proxyHdrs.delete("expect");

		// X-Forwarded-* headers
		proxyHdrs.set("x-forwarded-host", url.host);
		proxyHdrs.set("x-forwarded-proto", url.protocol.replace(":", ""));
		proxyHdrs.set("x-forwarded-for", ctx.ip);

		const proxyReq = new Request(targetUrl, {
			method: req.method,
			headers: proxyHdrs,
			body: req.body,
			redirect: "follow",
		});

		const resp = await fetch(proxyReq);

		// Create response with cleaned headers
		const respHdrs = new Headers(resp.headers);
		respHdrs.delete("connection");
		respHdrs.delete("keep-alive");
		respHdrs.delete("transfer-encoding");

		//
		return new Response(resp.body, {
			status: resp.status,
			statusText: resp.statusText,
			headers: respHdrs,
		});
	};

	return timeout
		? withTimeout(_proxy, timeout, "Proxy request timed out")
		: _proxy;
}
