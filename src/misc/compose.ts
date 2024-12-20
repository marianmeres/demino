import type { Demino } from "../demino.ts";

/**
 * Allows to compose multiple demino apps into a single one.
 */
export function deminoCompose(
	apps: Demino[],
	notFoundHandler?: (
		req: Request,
		info: Deno.ServeHandlerInfo
	) => Response | Promise<Response>
): Deno.ServeHandler {
	// helper to normalize paths as "/di/r/s/"
	const _slashed = (s: string) => {
		if (!s.startsWith("/")) s = "/" + s;
		if (!s.endsWith("/")) s += "/";
		return s;
	};

	// in case of the same mountPaths, the later wins
	const mounts = apps.reduce(
		(m, a) => ({ ...m, [_slashed(a.mountPath() || "/")]: a }),
		{} as Record<string, Demino>
	);
	// console.log(Object.keys(mounts));

	notFoundHandler ??= () => new Response("Not Found", { status: 404 });

	// return composed Deno.ServeHandler
	return (req: Request, info: Deno.ServeHandlerInfo) => {
		const url = new URL(req.url);

		// root special case
		if ("/" === url.pathname) {
			return mounts["/"]?.(req, info) ?? notFoundHandler(req, info);
		}

		// now start cutting off the path segments from the right, and try to match
		// against the mapped mount paths. This may not be 100% perfect in a wild
		// route and mount path scenarios, but is cheap and should just
		// get the job done in most cases most of the time.
		let pathname = url.pathname;
		let pos = pathname.lastIndexOf("/");
		while (pos > 0) {
			pathname = pathname.slice(0, pos);
			pos = pathname.lastIndexOf("/");
			const key = _slashed(pathname);
			if (mounts[key]) return mounts[key](req, info);
		}

		// fallback to root mount (if available)...
		return mounts["/"]?.(req, info) ?? notFoundHandler(req, info);
	};
}
