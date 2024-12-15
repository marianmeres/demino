// deno-lint-ignore-file no-explicit-any

import { green } from "@std/fmt/colors";
import { walkSync } from "@std/fs";
import { dirname, normalize } from "@std/path";
import {
	supportedMethods,
	type Demino,
	type DeminoHandler,
	type DeminoLogger,
	type DeminoMethod,
} from "./demino.ts";

/** `deminoFileBased` options */
export interface DeminoFileBasedOptions {
	/** Will log details (via logger) about found file based routes (default true). */
	verbose?: boolean;
	/** Custom logger (default console) */
	logger?: DeminoLogger;
}

/**
 * Will scan the provided root dirs for handlers (index.ts) and middlewares along the way (_middleware.ts),
 * and apply to the app. Each relative path for found index.ts file will be used as a route.
 * The path can contain named segments.
 *
 * A file path is considered as a **valid route** when:
 * - none of the path segments starts with "_" or "."
 * - the leaf index.[j|t]s file exists and exports at least one known symbol
 *
 * @example
 * ```ts
 * const app = demino();
 * await deminoFileBased(app, '/my/routes/dir/');
 * ```
 */
export async function deminoFileBased(
	app: Demino,
	rootDirs: string | string[],
	options?: DeminoFileBasedOptions
): Promise<Demino> {
	if (!Array.isArray(rootDirs)) rootDirs = [rootDirs];
	rootDirs = rootDirs.map(normalize);

	const log = options?.logger ?? console;

	const routes: Record<
		string,
		Partial<Record<"ALL" | DeminoMethod, DeminoHandler>>
	> = {};
	const middlewares: Record<string, DeminoHandler[]> = {};

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
				routes[route] = await _importRouteHandlers(filepath);
			} else if (type === "middleware") {
				middlewares[route] = await _importMiddlewares(filepath);
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
		[...(supportedMethods as any), "ALL"].forEach(
			(method: "ALL" | DeminoMethod) => {
				if (handler[method]) {
					// allow to set mws on the fn itself, eg: "GET.middlewares"
					let selfMws: DeminoHandler[] =
						(handler[method] as any)?.middlewares ?? [];
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
			log.debug(green(` ✔ ${method} ${route} (${mws.length} mws)`));
		// console.log(method.toLocaleLowerCase(), handler);
		(app as any)[method.toLocaleLowerCase()](route, mws, handler);
	});

	return app;
}

/**
 * Internal utility to sort routes, where route **specificity** is being compared.
 * Point is that since the first route match wins, we need to add dynamic routes after the
 * fixed ones.
 *
 * Routes specificity:
 * - depth (the higher depth, the more specific)
 * - named vs fixed segments /x vs /[x] (the dynamic must come last)
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
async function _importRouteHandlers(
	filepath: string
): Promise<Partial<Record<"ALL" | DeminoMethod, DeminoHandler>>> {
	const module = await import(filepath);
	const out: Partial<Record<"ALL" | DeminoMethod, DeminoHandler>> = {};

	let found = 0;
	[...(supportedMethods as any), "ALL"].forEach(
		(method: "ALL" | DeminoMethod) => {
			if (typeof module[method] === "function") {
				out[method] = module[method];
				found++;
			}
		}
	);

	if (!found) {
		throw new TypeError(
			`No expected route handlers found in ${filepath}. (Hint: file must export HTTP method named functions.)`
		);
	}

	return out;
}

/** Will import filepath as a js module and look for known exports */
async function _importMiddlewares(filepath: string): Promise<DeminoHandler[]> {
	const module = await import(filepath);
	const out: DeminoHandler[] = [];
	const hint =
		"(Hint: file must default export array of middleware functions.)";

	if (!Array.isArray(module.default)) {
		throw new TypeError(`Invalid middleware file ${filepath}. ${hint}`);
	}

	module.default.forEach((v: any) => {
		if (typeof v === "function") {
			out.push(v);
		} else {
			throw new TypeError(
				`Not a function middleware type in ${filepath}. ${hint}`
			);
		}
	});

	// empty is ok
	return out;
}
