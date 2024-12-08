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

	/** Stores a callback to be executed on a given route match. */
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
		if (!["", "*"].includes(route) && !route.startsWith("/")) {
			throw new TypeError(
				`Route must be either empty, or start with a forward slash.`
			);
		}
	}
}
