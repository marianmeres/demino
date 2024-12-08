import {
	DeminoRouter,
	type DeminoRouterOnMatch,
	type DeminoRouterOnMatchResult,
} from "./abstract.ts";

/**
 * Regular expressions based router.
 *
 * @example
 *
 * ```ts
 * const app = demino("", [], { routerFactory: () => new DeminoRegexRouter() });
 *
 * // named groups will be returned as params
 * // eg route `/2024-12` will be matched with context.params { year: "2024", month: "12"}
 * app.get("^/(?<year>\\d{4})-(?<month>\\d{2})$", ...);
 * ```
 *
 * @see regex-router.test.ts
 */
export class DeminoRegexRouter extends DeminoRouter {
	/** Internal Map of registered routes. */
	#routes = new Map<RegExp, DeminoRouterOnMatch>();

	/** Stores a callback to be executed on a given route match. */
	on(route: string, callback: DeminoRouterOnMatch): void {
		this.#routes.set(new RegExp(route), callback);
	}

	/** Executes pathname match lookup against the registered routes. */
	exec(pathname: string): null | DeminoRouterOnMatchResult {
		for (const [regex, callback] of this.#routes.entries()) {
			const match = regex.exec(pathname);
			if (match) {
				return callback(match.groups || {});
			}
		}
		return null;
	}

	/** Any string is a valid route for this router */
	override assertIsValid(route: string): Error | void {
		if (typeof route !== "string") {
			throw new TypeError(`Route must be a string`);
		}
	}
}
