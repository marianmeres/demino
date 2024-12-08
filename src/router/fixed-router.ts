import {
	DeminoRouter,
	type DeminoRouterOnMatch,
	type DeminoRouterOnMatchResult,
} from "./abstract.ts";

/**
 * The most simple router implementation. Basically is just directly comparing
 * 2 string. Unable to extract params from routes.
 *
 * While fully functional, serves mainly as an example of a custom router implementation.
 *
 * @example
 *
 * ```ts
 * const app = demino("", [], { routerFactory: () => new DeminoFixedRouter() });
 * app.get("/foo", () => "foo");
 * ```
 *
 * @see fixed-router.test.ts
 */
export class DeminoFixedRouter extends DeminoRouter {
	/** Internal Map of registered routes. */
	#routes = new Map<string, DeminoRouterOnMatch>();

	/** Stores a callback to be executed on a given route. */
	on(route: string, callback: DeminoRouterOnMatch): void {
		this.#routes.set(route, callback);
	}

	/** Executes pathname match lookup against the registered routes. */
	exec(pathname: string): null | DeminoRouterOnMatchResult {
		return this.#routes.has(pathname) ? this.#routes.get(pathname)!({}) : null;
	}
}
