import { SimpleRouter } from "@marianmeres/simple-router";
import {
	DeminoRouter,
	type DeminoRouterOnMatch,
	type DeminoRouterOnMatchResult,
} from "./abstract.ts";

/** Default router based on https://github.com/marianmeres/simple-router */
export class DeminoSimpleRouter extends DeminoRouter {
	/** Internal SimpleRouter instance */
	#router: SimpleRouter = new SimpleRouter();

	/** Stores a callback to be executed on a given route. */
	on(route: string, callback: DeminoRouterOnMatch): void {
		this.#router.on(route, callback);
	}

	/** Executes pathname match lookup against the registered routes. */
	exec(pathname: string): null | DeminoRouterOnMatchResult {
		return this.#router.exec(pathname);
	}

	/** Should throw if route is not valid for this router.
	 * It is used just as a friendly warning when registering routes. */
	override assertIsValid(route: string): Error | void {
		if (
			// the * wildcard is a SimpleRouter feature
			!["", "*"].includes(route) &&
			// this check is just an artificial one, it would technically work as
			// SimpleRouter sanitizes them anyway, but here it feels like they would be
			// just adding ambiguity
			(!route.startsWith("/") || route.includes("//"))
		) {
			throw new TypeError(
				`Route must be either empty, or start with a slash (and must not contain double slashes).`
			);
		}
	}

	/** Return string of all registered route definitions */
	override info(): string[] {
		return Object.keys(this.#router.info());
	}
}
