import {
	DeminoRouter,
	type DeminoRouterOnMatch,
	type DeminoRouterOnMatchResult,
} from "./abstract.ts";

/**
 * Regular expressions based router. Powerful, but harder to use (may throw `SyntaxErrors`
 * on malformed input).
 *
 * @example
 *
 * ```ts
 * const app = demino("", [], { routerFactory: () => new DeminoRegexRouter() });
 *
 * // named groups will be returned as params
 * app.get("^/(?<year>\\d{4})$", (_r, _i, c) => c.params);
 * app.get("^/(?<year>\\d{4})-(?<month>\\d{2})$", (_r, _i, c) => c.params);
 *
 * // fixed, no params
 * app.get("^/$", () => "home");
 * app.get("^/foo$", () => "foo");
 *
 * // catch all else
 * app.get(".+", () => "any");
 * ```
 *
 * @see regex-router.test.ts
 */
export class DeminoRegexRouter extends DeminoRouter {
	/** Internal Map of registered routes. */
	#routes = new Map<RegExp, DeminoRouterOnMatch>();

	/** Stores a callback to be executed on a given route. */
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
