import {
	DeminoRouter,
	type DeminoRouterOnMatch,
	type DeminoRouterOnMatchResult,
} from "./abstract.ts";

/**
 * Proof of concept Express-like router toy implementation.
 *
 * @deprecated use DeminoUrlPatternRouter
 * @see express-like-router.test.ts
 */
export class DeminoExpressLikeRouter extends DeminoRouter {
	/** Internal Map of registered routes. */
	#routes = new Map<string, DeminoRouterOnMatch>();

	/** Internal segments splitter */
	#parse(path: string) {
		return path.split("/").filter(Boolean);
	}

	/** Stores a callback to be executed on a given route. */
	on(route: string, callback: DeminoRouterOnMatch): void {
		this.#routes.set(route, callback);
	}

	/** Executes pathname match lookup against the registered routes. */
	exec(pathname: string): null | DeminoRouterOnMatchResult {
		const parts = this.#parse(pathname);

		top: for (const [route, callback] of this.#routes.entries()) {
			const defs = this.#parse(route);

			// cheap check first, if segment count don't match, route don't mach
			if (defs.length !== parts.length) continue;

			const params: Record<string, string> = {};

			for (let i = 0; i < defs.length; i++) {
				const def = defs[i];
				const part = parts[i];

				if (def.startsWith(":")) {
					const name = def.slice(1); // remove the ":" prefix
					params[name] = part;
				} // If it's a static segment and doesn't match, route don't match
				else if (def !== part) {
					break top;
				}
			}

			return callback(params);
		}

		return null;
	}
}
