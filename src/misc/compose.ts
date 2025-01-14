import type { Demino } from "../demino.ts";

/**
 * Allows to compose multiple demino apps into a single one.
 */
export function deminoCompose(
	apps: Demino[],
	notFoundHandler?: (
		req: Request,
		info: Deno.ServeHandlerInfo,
	) => Response | Promise<Response>,
): Deno.ServeHandler {
	// in case of the same mountPaths, the later wins
	const mounts = apps.reduce(
		(m, a) => ({ ...m, [a.mountPath() || "/"]: a }),
		{} as Record<string, Demino>,
	);
	// console.log(Object.keys(mounts));

	notFoundHandler ??= () => new Response("Not Found", { status: 404 });

	// return composed Deno.ServeHandler
	return (req: Request, info: Deno.ServeHandlerInfo) => {
		const url = new URL(req.url);

		// do we have a direct hit?
		if (mounts[url.pathname]) {
			return mounts[url.pathname](req, info);
		}

		// Now start cutting off the path segments from the right, and try to match
		// against the mapped mount paths. Since we're enforcing the mount paths without
		// the trailing slash, this should work 100%.
		let pathname = url.pathname;
		while (pathname) {
			pathname = pathname.slice(0, pathname.lastIndexOf("/"));
			const key = pathname || "/";
			if (mounts[key]) return mounts[key](req, info);
		}

		return notFoundHandler(req, info);
	};
}
