import { HTTP_STATUS } from "@marianmeres/http-utils";
import type { DeminoContext, DeminoHandler } from "../demino.ts";

/**
 * Creates a middleware that enforces trailing slash policy with 301 redirects.
 *
 * Helps maintain consistent URL structure for SEO purposes. By default, routers
 * treat `/foo` and `/foo/` as the same route, but search engines see them as different.
 *
 * Smart behavior:
 * - Only affects GET/HEAD requests
 * - Skips root path `/`
 * - Skips paths that look like files (contain a dot in last segment)
 * - Positions itself at the start of middleware stack for efficiency
 *
 * @param flag - true to add trailing slashes, false to remove them
 * @param options - Optional configuration
 * @returns Middleware handler that redirects to enforce trailing slash policy
 *
 * @example Enforce trailing slashes
 * ```ts
 * import { trailingSlash } from "@marianmeres/demino";
 *
 * app.use(trailingSlash(true));
 * // /foo/bar -> 301 redirect to /foo/bar/
 * ```
 *
 * @example Remove trailing slashes
 * ```ts
 * app.use(trailingSlash(false));
 * // /foo/bar/ -> 301 redirect to /foo/bar
 * ```
 *
 * @example With debug logging
 * ```ts
 * app.use(trailingSlash(true, {
 *   logger: (msg) => console.log(msg)
 * }));
 * ```
 */
export function trailingSlash(
	flag: boolean,
	options?: {
		/** Optional logger for debugging redirect behavior */
		logger?: CallableFunction;
	},
): DeminoHandler {
	const midware: DeminoHandler = (
		req: Request,
		_i: Deno.ServeHandlerInfo,
		ctx: DeminoContext,
	) => {
		// Mutable copy of the effective request URL — never mutate the shared
		// `ctx.url`. Only `pathname`/`search` are read, so the scheme/host are
		// irrelevant here anyway (the emitted `Location` is relative).
		const url = new URL(ctx.url);

		// no-op if not GET or can't say explicitly or we are at the root
		if (
			!["GET", "HEAD"].includes(req.method) ||
			flag === undefined ||
			"/" === url.pathname
		) {
			return;
		}

		// pick last segment, and if it (naively) looks like file (includes dot), noop as well
		const last = url.pathname.split("/").at(-1);
		if (last?.includes(".")) return;

		// This is always a SAME-ORIGIN redirect (same host, tweaked path), so emit
		// a RELATIVE `Location`. Behind a TLS-terminating proxy the proxy->app hop
		// is plain HTTP; an absolute `Location` from `req.url` would wrongly carry
		// `http://` on an HTTPS site. A relative target sidesteps that entirely —
		// the client resolves it against the URL it used and keeps its scheme.

		// add slash
		if (flag && !url.pathname.endsWith("/")) {
			url.pathname += "/";
			options?.logger?.(`[trailingSlash] 301 -> '${url.pathname}${url.search}'`); // debug
			return new Response(null, {
				status: HTTP_STATUS.MOVED_PERMANENTLY,
				headers: { location: url.pathname + url.search },
			});
		} // remove slash
		else if (!flag && url.pathname.endsWith("/")) {
			url.pathname = url.pathname.slice(0, -1);
			options?.logger?.(`[trailingSlash] 301 -> '${url.pathname}${url.search}'`);
			return new Response(null, {
				status: HTTP_STATUS.MOVED_PERMANENTLY,
				headers: { location: url.pathname + url.search },
			});
		}
	};

	// this does the trick o moving the midware to front
	midware.__midwarePreExecuteSortOrder = -Infinity;

	return midware;
}
