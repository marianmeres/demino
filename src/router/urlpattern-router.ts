import {
	DeminoRouter,
	type DeminoRouterOnMatch,
	type DeminoRouterOnMatchResult,
} from "./abstract.ts";

/**
 * [Url Pattern](https://developer.mozilla.org/en-US/docs/Web/API/URL_Pattern_API) based router.
 *
 * @example
 *
 * ```ts
 * const app = demino("", [], { routerFactory: () => new DeminoUrlPatternRouter() });
 *
 * // named groups will be returned as params
 * app.get("/books", (_r, _i, c) => c.params);
 * app.get("/books/:id", (_r, _i, c) => c.params);
 *
 * ```
 *
 * @see urlpattern-router.test.ts
 */
export class DeminoUrlPatternRouter extends DeminoRouter {
	/** Internal Map of registered routes. */
	#routes = new Map<URLPattern, DeminoRouterOnMatch>();

	/** Stores a callback to be executed on a given route. */
	on(route: string, callback: DeminoRouterOnMatch): void {
		this.#routes.set(new URLPattern({ pathname: route }), callback);
	}

	/** Executes pathname match lookup against the registered routes. */
	exec(pathname: string): null | DeminoRouterOnMatchResult {
		for (const [pattern, callback] of this.#routes.entries()) {
			const match = pattern.exec({ pathname });
			if (match) {
				// @ts-ignore: groups can have undefined record values, and we formally support only empty strings...
				return callback(match.pathname.groups || {});
			}
		}
		return null;
	}

	/** Returns all registered route pattern strings. */
	override info(): string[] {
		return Array.from(this.#routes.keys()).map((p) => p.pathname);
	}
}
