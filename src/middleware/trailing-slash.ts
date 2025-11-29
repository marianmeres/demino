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
		_ctx: DeminoContext,
	) => {
		const url = new URL(req.url);

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

		// add slash
		if (flag && !url.pathname.endsWith("/")) {
			url.pathname += "/";
			options?.logger?.(`[trailingSlash] 301 -> '${url.toString()}'`); // debug
			return Response.redirect(url.toString(), HTTP_STATUS.MOVED_PERMANENTLY);
		} // remove slash
		else if (!flag && url.pathname.endsWith("/")) {
			url.pathname = url.pathname.slice(0, -1);
			options?.logger?.(`[trailingSlash] 301 -> '${url.toString()}'`);
			return Response.redirect(url.toString(), HTTP_STATUS.MOVED_PERMANENTLY);
		}
	};

	// this does the trick o moving the midware to front
	midware.__midwarePreExecuteSortOrder = -Infinity;

	return midware;
}
