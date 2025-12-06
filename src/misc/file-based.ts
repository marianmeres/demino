import { encodeBase64 } from "@std/encoding";
import { green } from "@std/fmt/colors";
import { walkSync } from "@std/fs";
import { dirname, normalize } from "@std/path";
import {
	type Demino,
	type DeminoHandler,
	type DeminoLogger,
	type DeminoMethod,
	type Logger,
	supportedMethods,
} from "../demino.ts";

/**
 * Configuration options for file-based routing.
 */
export interface DeminoFileBasedOptions {
	/** Will log details (via logger) about found file based routes (default true). */
	verbose?: boolean;
	/** Custom logger (default console) */
	logger?: DeminoLogger | null | undefined;
	/**
	 * https://docs.deno.com/deploy/api/dynamic-import/
	 * This hoisted importer is only required if the imported module is using other relative
	 * imports.
	 */
	doImport?: (modulePath: string) => Promise<Record<string, unknown>>;
}

/**
 * Enables directory-based routing by scanning filesystem for route handlers.
 *
 * Automatically discovers and registers routes from directory structure:
 * - `index.(j|t)s` files define route handlers (must export HTTP method functions)
 * - `_middleware.(j|t)s` files define middlewares (must default export array)
 * - Directory names become route segments (e.g., `/users/[id]/`)
 * - Directories starting with `_` or `.` are ignored
 * - Named segments use bracket notation: `[paramName]`
 *
 * Route validity requirements:
 * - No path segment may start with `_` or `.`
 * - `index.(j|t)s` must export at least one HTTP method function (GET, POST, etc.)
 *
 * @param app - Demino application instance to register routes on
 * @param rootDirs - Directory or directories to scan for routes
 * @param options - Optional configuration
 * @returns The same app instance (for chaining)
 *
 * @example Basic usage
 * ```ts
 * import { demino, deminoFileBased } from "@marianmeres/demino";
 *
 * const app = demino();
 * await deminoFileBased(app, "./routes");
 * Deno.serve(app);
 * ```
 *
 * @example Directory structure
 * ```
 * routes/
 * ├── _middleware.ts           # Global middleware
 * ├── index.ts                 # GET / handler
 * ├── users/
 * │   ├── _middleware.ts       # Middleware for /users/*
 * │   ├── index.ts             # GET /users handler
 * │   └── [userId]/
 * │       └── index.ts         # GET /users/[userId] handler
 * ```
 *
 * @example Route handler file (index.ts)
 * ```ts
 * // Export HTTP method named functions
 * export function GET(req, info, ctx) {
 *   return { users: [...] };
 * }
 *
 * export function POST(req, info, ctx) {
 *   return { created: true };
 * }
 * ```
 *
 * @example Middleware file (_middleware.ts)
 * ```ts
 * // Must default export array of middlewares
 * export default [authMiddleware, loggingMiddleware];
 * ```
 */
export async function deminoFileBased(
	app: Demino,
	rootDirs: string | string[],
	options?: DeminoFileBasedOptions
): Promise<Demino> {
	if (!Array.isArray(rootDirs)) rootDirs = [rootDirs];
	rootDirs = rootDirs.map(normalize);

	const log: DeminoLogger = options?.logger ?? (console as unknown as Logger);

	const routes: Record<
		string,
		Partial<Record<"ALL" | DeminoMethod, DeminoHandler>>
	> = {};
	const middlewares: Record<string, DeminoHandler[]> = {};

	const _defatulImporter = async (modulePath: string) => {
		// https://docs.deno.com/deploy/api/dynamic-import/
		const type = /\.ts$/i.test(modulePath) ? "typescript" : "javascript";
		const jsSource = encodeBase64(Deno.readTextFileSync(modulePath));
		return await import(`data:text/${type};base64,${jsSource}`);
	};

	const doImport = options?.doImport ?? _defatulImporter;

	for (const rootDir of rootDirs) {
		for (const dirEntry of walkSync(rootDir, {
			includeDirs: false,
			// we are cosuming only ts/js here
			exts: ["js", "ts"],
		})) {
			// ignore dotfiles quickly
			if (dirEntry.name.startsWith(".")) continue;
			const filepath = dirEntry.path;
			const name = dirEntry.name;

			// route is the "relative" dirname portion (also, try to windows normalize)
			const route = dirname(filepath.slice(rootDir.length)).replace("\\", "/");
			let type: "routeHandler" | "middleware";

			// 1. formal filename checks first (and skip processing asap)

			if (!_isRouteValidDirName(route)) continue;

			if (_isRouteHandlerValidFilename(name)) type = "routeHandler";
			else if (_isMiddlewareValidFilename(name)) type = "middleware";
			else continue;

			// 2. path is formally valid, now need to investigate the exported symbols

			if (type === "routeHandler") {
				options?.verbose && log?.debug?.(green(`${filepath}`));
				routes[route] = await _importRouteHandlers(
					await doImport(filepath),
					filepath,
					options?.verbose ? log?.debug : undefined
				);
			} else if (type === "middleware") {
				options?.verbose && log?.debug?.(green(`${filepath}`));
				middlewares[route] = await _importMiddlewares(
					await doImport(filepath),
					filepath,
					options?.verbose ? log?.debug : undefined
				);
			}
		}
	}

	// 3. sort by specificity
	const routesSorted = Object.keys(routes).toSorted(routesCompare);
	// console.log({ routes, middlewares });

	// finally collect middlewares and return final definitions

	const collectMiddlewaresFor = (route: string): DeminoHandler[] => {
		const out = [];
		const backup = route;

		// try root / first
		out.push(...(middlewares?.["/"] || []).flat());

		if (backup !== "/") {
			// now collect the in-between ones (that is between root / and self).
			const tmp = [];
			let pos = route.lastIndexOf("/");
			while (pos > 0) {
				route = route.slice(0, pos);
				pos = route.lastIndexOf("/");
				tmp.push(...(middlewares?.[route] || []).flat());
			}
			// we were collecting it in a reversed order above, so need to un-reverse before adding
			out.push(...tmp.toReversed());

			// finally add self
			out.push(...(middlewares?.[backup] || []).flat());
		}

		return out.filter(Boolean);
	};

	const defs: [string, "ALL" | DeminoMethod, DeminoHandler[], DeminoHandler][] =
		[];

	routesSorted.forEach((route: string) => {
		const mws = collectMiddlewaresFor(route);
		const handler = routes[route];
		([...supportedMethods, "ALL"] as const).forEach(
			(method: "ALL" | DeminoMethod) => {
				if (handler[method]) {
					// allow to set mws on the fn itself, eg: "GET.middlewares"
					let selfMws: DeminoHandler[] =
						(handler[method] as DeminoHandler & { middlewares?: DeminoHandler | DeminoHandler[] })?.middlewares as DeminoHandler[] ?? [];
					if (!Array.isArray(selfMws)) selfMws = [selfMws];
					defs.push([
						route,
						method,
						[...mws, ...selfMws].filter(Boolean),
						handler[method],
					]);
				}
			}
		);
	});

	// final apply
	defs.forEach(([route, method, mws, handler]) => {
		options?.verbose &&
			log?.debug?.(green(` ✔ ${method} ${route} (${mws.length} mws)`));
		// console.log(method.toLocaleLowerCase(), handler);
		const methodName = method.toLowerCase() as Lowercase<typeof method>;
		(app[methodName] as Demino["get"])(route, mws, handler);
	});

	return app;
}

/**
 * Comparator function to sort routes by specificity.
 *
 * Ensures static routes are matched before dynamic ones, since first match wins.
 *
 * Specificity rules:
 * 1. Deeper routes are more specific (more segments = higher priority)
 * 2. Static segments beat dynamic segments at same position
 * 3. Alphabetically sorted when specificity is equal
 *
 * @param a - First route path
 * @param b - Second route path
 * @returns Negative if a is more specific, positive if b is more specific, 0 if equal
 *
 * @example
 * ```ts
 * const routes = ["/users/[id]", "/users/admin", "/api", "/api/v2/users"];
 * routes.sort(routesCompare);
 * // Result: ["/api/v2/users", "/api", "/users/admin", "/users/[id]"]
 * // Deeper first, then static before dynamic
 * ```
 */
export function routesCompare(a: string, b: string): number {
	const s = "/";
	const aSegments = `${a}`.split(s).filter(Boolean);
	const bSegments = `${b}`.split(s).filter(Boolean);

	// easy case - different depth
	if (aSegments.length !== bSegments.length) {
		return bSegments.length - aSegments.length; // desc
	}

	const isDynamic = (s: string) => s.startsWith("[");

	// now start comparing from the first segment...
	for (let i = 0; i < aSegments.length; i++) {
		const sa = aSegments[i];
		const sb = bSegments[i];
		// A positive value indicates that a should come after b.
		if (isDynamic(sa) && !isDynamic(sb)) return 1;
		// A negative value indicates that a should come before b.
		else if (!isDynamic(sa) && isDynamic(sb)) return -1;
		// else no-op as can't decide
	}

	// either are fully static or fully dynamic - sort alphabetically (for the dynamic case
	// it won't have any effect)
	return aSegments.join().localeCompare(bSegments.join());
}

/** Route dir name validator - none of the route segments may start with dot or underscore */
function _isRouteValidDirName(filename: string): boolean {
	return !filename.includes("/.") && !filename.includes("/_");
}

/** Route handler file name validator - only index.js or index.ts are supported */
function _isRouteHandlerValidFilename(filename: string): boolean {
	return /^index\.(j|t)s$/.test(filename);
}

/** Middleware file name validator - _middleware.ts|js is supported */
function _isMiddlewareValidFilename(filename: string) {
	return /^_middleware\.(j|t)s$/.test(filename);
}

/** Will import filepath as a js module and look for known exports */
function _importRouteHandlers(
	module: Record<string, unknown>,
	fileDebugLabel: string,
	debugLog?: CallableFunction
): Partial<Record<"ALL" | DeminoMethod, DeminoHandler>> {
	// https://docs.deno.com/deploy/api/dynamic-import/
	// filepath = relative(import.meta.dirname!, filepath);
	// const module = await import(`./${filepath}`);

	const out: Partial<Record<"ALL" | DeminoMethod, DeminoHandler>> = {};

	let found = 0;
	([...supportedMethods, "ALL"] as const).forEach(
		(method: "ALL" | DeminoMethod) => {
			if (typeof module[method] === "function") {
				out[method] = module[method] as DeminoHandler;
				found++;
			}
		}
	);

	if (!found) {
		throw new TypeError(
			`No expected route handlers found in ${fileDebugLabel}. (Hint: file must export HTTP method named functions.)`
		);
	} else {
		debugLog?.(` ✔ found: ${Object.keys(out).join(", ")}`);
	}

	return out;
}

/** Will import filepath as a js module and look for known exports */
function _importMiddlewares(
	module: Record<string, unknown>,
	fileDebugLabel: string,
	debugLog?: CallableFunction
): DeminoHandler[] {
	// https://docs.deno.com/deploy/api/dynamic-import/
	// filepath = relative(import.meta.dirname!, filepath);
	// const module = await import(`./${filepath}`);

	//
	const out: DeminoHandler[] = [];
	const hint =
		"(Hint: file must default export array of middleware functions.)";

	if (!Array.isArray(module.default)) {
		throw new TypeError(`Invalid middleware file ${fileDebugLabel}. ${hint}`);
	}

	module.default.forEach((v: unknown) => {
		if (typeof v === "function") {
			out.push(v as DeminoHandler);
		} else {
			throw new TypeError(
				`Not a function middleware type in ${fileDebugLabel}. ${hint}`
			);
		}
	});

	if (out.length) {
		debugLog?.(` ✔ found: ${out.length}`);
	}

	// empty is ok
	return out;
}
