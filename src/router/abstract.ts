// deno-lint-ignore-file no-explicit-any

import type { DeminoHandler, DeminoMethod } from "../demino.ts";

/** Internal on route match callback result type */
export type DeminoRouterOnMatchResult = {
	params: Record<string, string>;
	// midware: Midware<DeminoHandlerArgs>;
	midwares: (DeminoHandler | DeminoHandler[])[];
	route: string;
};

/** Internal on route match callback type */
export type DeminoRouterOnMatch = (
	params: Record<string, string>
) => DeminoRouterOnMatchResult;

/** DeminoRouter abstract class. */
export abstract class DeminoRouter {
	/** Defines a callback to be executed on a given route. */
	abstract on(route: string, callback: DeminoRouterOnMatch): void;

	/** Executes pathname match lookup against the registered routes. */
	abstract exec(pathname: string): null | DeminoRouterOnMatchResult;

	/** Should throw if route is not valid for this router.
	 * It is used just as a friendly warning when registering routes. */
	assertIsValid(route: string): Error | void {
		// because url.pathname always starts with "/"... so we are not confused later
		if (!route.startsWith("/")) {
			throw new TypeError(`Route must start with a forward slash`);
		}
	}

	/** Return string of all registered route definitions */
	info(): string[] {
		throw new Error("Not implemented");
	}
}
