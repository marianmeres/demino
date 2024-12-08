import {
	DeminoRouter,
	type DeminoRouterOnMatch,
	type DeminoRouterOnMatchResult,
} from "./abstract.ts";

/**
 * The most simple router implementation. While fully functional,
 * serves mainly as an example of a custom router implementation.
 *
 * @see fixed-router.test.ts
 */
export class DeminoFixedRouter extends DeminoRouter {
	/** Internal Map of registered routes. */
	#routes = new Map<string, DeminoRouterOnMatch>();

	/** Stores a callback to be executed on a given route match. */
	on(route: string, callback: DeminoRouterOnMatch): void {
		this.#routes.set(route, callback);
	}

	/** Executes pathname match lookup against the registered routes. */
	exec(pathname: string): null | DeminoRouterOnMatchResult {
		return this.#routes.has(pathname) ? this.#routes.get(pathname)!({}) : null;
	}
}
