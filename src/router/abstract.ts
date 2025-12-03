import type { DeminoHandler } from "../demino.ts";

/**
 * Result type returned by the router when a route matches.
 * Contains parsed parameters, middleware chain, and the matched route pattern.
 */
export type DeminoRouterOnMatchResult = {
	/** Parsed route parameters as key-value pairs */
	params: Record<string, string>;
	/** Middleware chain for this route */
	midwares: (DeminoHandler | DeminoHandler[])[];
	/** The matched route pattern (e.g., "/users/[id]") */
	route: string;
};

/**
 * Callback function invoked when a route matches.
 * Receives parsed parameters and returns full match result.
 */
export type DeminoRouterOnMatch = (
	params: Record<string, string>,
) => DeminoRouterOnMatchResult;

/**
 * Abstract base class for Demino routers.
 *
 * Implement this class to create custom routing strategies. Demino comes with
 * several built-in implementations:
 * - `DeminoSimpleRouter` - Default router using bracket notation (e.g., `/users/[id]`)
 * - `DeminoUrlPatternRouter` - Uses the URL Pattern API (e.g., `/users/:id`)
 * - `DeminoFixedRouter` - Simple string matching, no parameters
 * - `DeminoRegexRouter` - Full regex-based routing
 *
 * @example Creating a custom router
 * ```ts
 * class MyRouter extends DeminoRouter {
 *   on(route: string, callback: DeminoRouterOnMatch): void { ... }
 *   exec(pathname: string): DeminoRouterOnMatchResult | null { ... }
 * }
 *
 * const app = demino("", [], { routerFactory: () => new MyRouter() });
 * ```
 */
export abstract class DeminoRouter {
	/**
	 * Registers a route with a callback to execute when matched.
	 * @param route - The route pattern to match
	 * @param callback - Function called when route matches, returns match result
	 */
	abstract on(route: string, callback: DeminoRouterOnMatch): void;

	/**
	 * Attempts to match a pathname against registered routes.
	 * @param pathname - The URL pathname to match (e.g., "/users/123")
	 * @returns Match result with params and middlewares, or null if no match
	 */
	abstract exec(pathname: string): DeminoRouterOnMatchResult | null;

	/**
	 * Validates whether a route pattern is valid for this router.
	 * Throws TypeError if the route is invalid.
	 *
	 * @param route - The route pattern to validate
	 * @throws {TypeError} If route doesn't start with "/"
	 */
	assertIsValid(route: string): void {
		// because url.pathname always starts with "/"... so we are not confused later
		if (!route.startsWith("/")) {
			throw new TypeError(`Route must start with a forward slash`);
		}
	}

	/**
	 * Returns all registered route patterns.
	 * Override in subclasses to provide route introspection.
	 *
	 * @returns Array of registered route pattern strings
	 * @throws {Error} If not implemented by subclass
	 */
	info(): string[] {
		throw new Error("Not implemented");
	}
}
