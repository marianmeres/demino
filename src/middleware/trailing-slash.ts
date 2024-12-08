import { moveSync } from "@std/fs/move";
import type { DeminoContext, DeminoHandler } from "../demino.ts";

/**
 * Will create the tralingSlash middleware which will redirect to the new location
 * (via 301 moved permanently) if needed, either WITH the trailing slash, or WITHOUT it.
 *
 * If strategy "on": `/foo/bar` -> `/foo/bar/`
 * If strategy "off": `/foo/bar/` -> `/foo/bar`
 *
 * If there is nothing to do, will do nothing. This middleware will try to position itself
 * at the beginning of the middlewares stack, to potentially terminate the chain ASAP.
 */
export function createTrailingSlashMiddleware(
	options: { strategy: "on" | "off" } = { strategy: "off" }
): DeminoHandler {
	const midware: DeminoHandler = (
		req: Request,
		_i: Deno.ServeHandlerInfo,
		_ctx: DeminoContext
	) => {
		const url = new URL(req.url);

		//
		if (options.strategy === "on" && !url.pathname.endsWith("/")) {
			url.pathname += "/";
			return new Response(null, {
				status: 301,
				headers: { Location: url.toString() },
			});
		}
		//
		else if (options.strategy === "off" && url.pathname.endsWith("/")) {
			url.pathname = url.pathname.slice(0, -1);
			return new Response(null, {
				status: 301,
				headers: { Location: url.toString() },
			});
		}

		//
	};

	// this does the trick o moving the midware to front
	midware.__midwarePreExecuteSortOrder = 0;

	return midware;
}
