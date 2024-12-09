import { moveSync } from "@std/fs/move";
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
export function createTrailingSlashMiddleware(flag: boolean): DeminoHandler {
	const midware: DeminoHandler = (
		req: Request,
		_i: Deno.ServeHandlerInfo,
		_ctx: DeminoContext
	) => {
		// do nothing if can't say explicitly
		if (flag === undefined) return;

		const url = new URL(req.url);

		// add slash
		if (flag && !url.pathname.endsWith("/")) {
			url.pathname += "/";
			return new Response(null, {
				status: 301,
				headers: { Location: url.toString() },
			});
		}
		// remove slash
		else if (!flag && url.pathname.endsWith("/")) {
			url.pathname = url.pathname.slice(0, -1);
			return new Response(null, {
				status: 301,
				headers: { Location: url.toString() },
			});
		}
	};

	// this does the trick o moving the midware to front
	midware.__midwarePreExecuteSortOrder = 0;

	return midware;
}
