import type { Demino } from "../demino.ts";

/**
 * Composes multiple Demino applications into a single Deno.ServeHandler.
 *
 * Allows organizing routes into logical groups (e.g., API, admin, public) where each
 * group has its own isolated middleware stack and mount path.
 *
 * Route matching:
 * - Apps are matched by their mountPath in the order they're defined
 * - Later apps override earlier ones if they share the same mountPath
 * - Requests are matched by progressively stripping path segments
 * - Custom 404 handler can be provided (defaults to simple "Not Found" response)
 *
 * @param apps - Array of Demino applications to compose
 * @param notFoundHandler - Optional custom 404 handler
 * @returns Deno.ServeHandler ready to pass to Deno.serve()
 *
 * @example Basic composition
 * ```ts
 * import { demino, deminoCompose } from "@marianmeres/demino";
 *
 * const app = demino();
 * app.get("/", () => "Home");
 *
 * const api = demino("/api");
 * api.get("/users", getUsers);
 *
 * const admin = demino("/admin");
 * admin.use(requireAdmin);
 * admin.get("/dashboard", getDashboard);
 *
 * Deno.serve(deminoCompose([app, api, admin]));
 * ```
 *
 * @example With custom 404
 * ```ts
 * Deno.serve(deminoCompose(
 *   [app, api, admin],
 *   () => new Response("Custom 404", { status: 404 })
 * ));
 * ```
 *
 * @example Isolated middleware stacks
 * ```ts
 * const publicApp = demino();
 * publicApp.use(publicMiddleware);
 *
 * const apiApp = demino("/api");
 * apiApp.use(authMiddleware);  // Only affects /api/* routes
 *
 * const adminApp = demino("/admin");
 * adminApp.use(adminMiddleware);  // Only affects /admin/* routes
 *
 * Deno.serve(deminoCompose([publicApp, apiApp, adminApp]));
 * ```
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
