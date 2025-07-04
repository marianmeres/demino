import { HTTP_STATUS } from "@marianmeres/http-utils";
import type { DeminoContext, DeminoHandler } from "../demino.ts";

/**
 * Will create the tralingSlash middleware which will redirect to the new location
 * (via 301 moved permanently) if needed, either WITH the trailing slash, or WITHOUT it.
 *
 * If flag is TRUE: `/foo/bar` -> `/foo/bar/`
 * If flag is FALSE: `/foo/bar/` -> `/foo/bar`
 *
 * If there is nothing to do, will do nothing. This middleware will try to position itself
 * at the beginning of the middlewares stack, to potentially terminate the chain ASAP.
 */
export function trailingSlash(
	/** The master flag - TRUE: add slash, FALSE: remove slash */
	flag: boolean,
	options?: {
		/** For debugging */
		logger?: CallableFunction;
	}
): DeminoHandler {
	const midware: DeminoHandler = (
		req: Request,
		_i: Deno.ServeHandlerInfo,
		_ctx: DeminoContext
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
