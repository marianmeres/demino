// deno-lint-ignore-file no-explicit-any

import {
	createHttpError,
	getErrorMessage,
	HTTP_STATUS,
} from "@marianmeres/http-utils";
import { Midware, type MidwareUseFn } from "@marianmeres/midware";
import { green, red } from "@std/fmt/colors";
import type { DeminoRouter } from "./router/abstract.ts";
import { DeminoSimpleRouter } from "./router/simple-router.ts";
import { isPlainObject } from "./utils/is-plain-object.ts";
import { isValidDate } from "./utils/is-valid-date.ts";

/** Well known object passed to middlewares */
export interface DeminoContext {
	/** Route's parsed params (if available). */
	params: Record<string, string>;
	/** Userland read/write key-value map. */
	locals: Record<string, any>;
	/** Custom userland response (!) headers to be used in the final output. */
	headers: Headers;
	/** The response status to be used in the final response if auto generating the response (default 200). */
	status: number;
	/** Internal: timestamp of the incoming request. */
	__start: Date;
	/** Internal: error ref for the error handler */
	error: any;
}

/** Arguments passed to DeminoHandler (a.k.a. middleware) */
export type DeminoHandlerArgs = [Request, Deno.ServeHandlerInfo, DeminoContext];

/** Demino route handler AND middlware fn (both are of the same type) */
export interface DeminoHandler extends MidwareUseFn<DeminoHandlerArgs> {}

/** Route handler signature */
export type DeminoRouteHandler = (
	route: string,
	...args: (DeminoHandler | DeminoHandler[])[]
) => Demino;

/** The Demino app public interface */
export interface Demino extends Deno.ServeHandler {
	/** Special case _every_ HTTP method route handler. */
	all: DeminoRouteHandler;
	/** HTTP CONNECT route handler */
	connect: DeminoRouteHandler;
	/** HTTP DELETE route handler */
	delete: DeminoRouteHandler;
	/** HTTP GET route handler */
	get: DeminoRouteHandler;
	/** HTTP HEAD route handler */
	head: DeminoRouteHandler;
	/** HTTP OPTIONS route handler */
	options: DeminoRouteHandler;
	/** HTTP PATCH route handler */
	patch: DeminoRouteHandler;
	/** HTTP POST route handler */
	post: DeminoRouteHandler;
	/** HTTP PUT route handler */
	put: DeminoRouteHandler;
	/** HTTP TRACE route handler */
	trace: DeminoRouteHandler;
	/** Fn to register custom error handler. */
	error: (handler: DeminoHandler) => Demino;
	/**
	 * Fn to register "app global", or "route global" middlewares.
	 *
	 * If there are any strings among args, they will be understood as routes, and
	 * every middleware will be registered "route global" for each of the strings.
	 *
	 * If no strings are found, every provided middleware is considered as "app global".
	 *
	 * @example
	 * ```ts
	 * app.use(mw); // app global
	 * app.use([mw1, mw2], mw3); // app global
	 * app.use('/foo', mw1, mw2) // route global (for every route method)
	 *
	 * // all mws will be set as route globals for both /foo and /bar
	 * app.use(mw, '/foo', mw1, '/bar', mw2, mw3);
	 * ```
	 */
	use: (...args: (string | DeminoHandler | DeminoHandler[])[]) => Demino;
	/** Returns which path is the current app mounted on. */
	mountPath: () => string;
}

/** Demino supported method */
export type DeminoMethod =
	| "CONNECT"
	| "DELETE"
	| "GET"
	| "HEAD"
	| "OPTIONS"
	| "PATCH"
	| "POST"
	| "PUT"
	| "TRACE";

/** Internal list of supported methods */
export const supportedMethods: DeminoMethod[] = [
	"CONNECT",
	"DELETE",
	"GET",
	"HEAD",
	"OPTIONS",
	"PATCH",
	"POST",
	"PUT",
	"TRACE",
];

/** Internal logger inteface (experimental)... */
export interface DeminoLogger {
	error: (...args: any[]) => void;
	warn: (...args: any[]) => void;
	log: (...args: any[]) => void;
	debug: (...args: any[]) => void;
}

/** Internal DRY helper */
function isFn(v: any): boolean {
	return typeof v === "function";
}

/** Export few well known ones, for easier consumption in apps */
export const CONTENT_TYPE = {
	JSON: "application/json; charset=utf-8",
	TEXT: "text/plain; charset=utf-8",
	HTML: "text/html; charset=utf-8",
};

/** Creates Response based on body type */
function _createResponseFrom(
	body: any,
	headers: Headers = new Headers(),
	status = HTTP_STATUS.OK
) {
	status ||= HTTP_STATUS.OK;

	// make no assumptions - empty body is technically valid
	if (body === undefined) {
		body = null;
		status = HTTP_STATUS.NO_CONTENT;
	}
	// JSON.stringify
	else if (
		// considering NULL a common DTO use case
		body === null ||
		// toJSON aware
		isFn(body?.toJSON) ||
		// plain object without its own `toString` method
		(isPlainObject(body) &&
			!Object.prototype.hasOwnProperty.call(body, "toString"))
	) {
		body = JSON.stringify(body);
		if (!headers.has("content-type")) {
			headers.set("content-type", CONTENT_TYPE.JSON);
		}
	}
	// maybe any other auto detection here?
	// otherwise not much to guess anymore, simply cast to string
	else {
		body = `${body}`;
		if (!headers.has("content-type")) {
			headers.set("content-type", CONTENT_TYPE.HTML);
		}
	}

	return new Response(body, { status, headers });
}

/** Internal DRY helper */
function _createContext(params: Record<string, string>): DeminoContext {
	return Object.seal({
		params: Object.freeze(params),
		locals: {},
		headers: new Headers(),
		error: null,
		status: HTTP_STATUS.OK,
		__start: new Date(),
	});
}

/** Demino app factory options. */
export interface DeminoOptions {
	/** Function to return custom DeminoRouter instance. */
	routerFactory?: () => DeminoRouter;
	/** If truthy will not set `x-powered-by` header signature.
	 * Relevant only when auto-creating the Response (that is when middlewares
	 * chain returns anything other than Response instance). */
	noXPoweredBy?: boolean;
	/** If truthy will not set `x-response-time` header value.
	 * Relevant only when auto-creating the Response (that is when middlewares
	 * chain returns anything other than Response instance). */
	noXResponseTime?: boolean;
	/** Will log some more details. (via DeminoLogger) */
	verbose?: boolean;
	/** Custom logger (default console) */
	logger?: DeminoLogger;
}

/**
 * Creates the Demino app.
 *
 * Demino app is a valid `Deno.serve` handler function.
 *
 * @example
 * ```ts
 * Deno.serve(demino()); // this will return 404 for every request
 * ```
 */
export function demino(
	mountPath: string = "",
	middleware: DeminoHandler | DeminoHandler[] = [],
	options?: DeminoOptions
): Demino {
	// initialize and normalize...
	const _globalAppMws = Array.isArray(middleware) ? middleware : [middleware];
	const _globalRouteMws: Record<string, DeminoHandler[]> = {};
	const log = options?.logger ?? console;
	let _errorHandler: DeminoHandler;

	// either use provided, or fallback to default DeminoSimpleRouter
	const _routerFactory =
		typeof options?.routerFactory === "function"
			? options.routerFactory
			: () => new DeminoSimpleRouter();

	// prepare routers for each method individually
	const _routers = ["ALL", ...supportedMethods].reduce(
		(m, k) => ({ ...m, [k]: _routerFactory() }),
		{} as Record<"ALL" | DeminoMethod, DeminoRouter>
	);

	const _maybeSetXHeaders = (context: DeminoContext) => {
		if (!options?.noXPoweredBy) {
			context.headers.set("X-Powered-By", `Demino`);
		}
		if (!options?.noXResponseTime && isValidDate(context?.__start)) {
			context.headers.set(
				"X-Response-Time",
				`${new Date().valueOf() - context.__start.valueOf()}ms`
			);
		}
	};

	//
	const _createErrorResponse = async (
		req: Request,
		info: Deno.ServeHandlerInfo,
		context: DeminoContext
	) => {
		let r = await _errorHandler?.(req, info, context);
		if (!(r instanceof Response)) {
			_maybeSetXHeaders(context);
			// make sure to reset any content-type we might have (the factory below will set the proper one)
			context.headers.delete("content-type");
			r = _createResponseFrom(
				r || getErrorMessage(context.error),
				context.headers,
				context.error?.status || HTTP_STATUS.INTERNAL_SERVER_ERROR
			);
		}
		return r;
	};

	//
	const _app: Demino = async (req: Request, info: Deno.ServeHandlerInfo) => {
		const method: "ALL" | DeminoMethod = req.method as "ALL" | DeminoMethod;
		const url = new URL(req.url);
		let context = _createContext({});

		try {
			if (!_routers[method]) {
				throw createHttpError(HTTP_STATUS.NOT_IMPLEMENTED);
			}

			const route = url.pathname;
			let matched = _routers[method].exec(route);

			// if not matched, try ALL as a second attempt
			if (!matched && method !== "ALL") {
				matched = _routers.ALL.exec(route);
			}

			if (matched) {
				try {
					context = _createContext(matched.params);

					// The core Demino business - execute all middlewares...
					// The intended convenient practice is actually NOT to return the Response
					// instance directly (unlike with Deno.ServeHandler)
					let result = await matched.midware.execute([req, info, context]);

					//
					const headers = context?.headers || new Headers();

					// maybe some x-headers (this will work only if the result is not a Response instance)
					if (!(result instanceof Response)) {
						_maybeSetXHeaders(context);
					}

					// middleware returned error instead of throwing? Not a best practice, but possible...
					if (result instanceof Error) {
						context.error = result;
						result = _createErrorResponse(req, info, context);
					}
					// we need Response instance eventually...
					else if (!(result instanceof Response)) {
						result = _createResponseFrom(result, headers, context?.status);
					}

					return result;
				} catch (e: any) {
					const status = e.status || HTTP_STATUS.INTERNAL_SERVER_ERROR;
					throw createHttpError(status, null, null, e);
				}
			} else {
				throw createHttpError(HTTP_STATUS.NOT_FOUND);
			}
		} catch (e: any) {
			context.error = e;
			return _createErrorResponse(req, info, context);
		}
	};

	//
	const _createRouteFn =
		(method: "ALL" | DeminoMethod): DeminoRouteHandler =>
		(route: string, ...args: (DeminoHandler | DeminoHandler[])[]): Demino => {
			// everything is a middleware...
			const midwares: DeminoHandler[] = [
				..._globalAppMws,
				...(_globalRouteMws[route] || []),
				...args,
			]
				.flat()
				.filter(Boolean)
				.map((mw, i, arr) => {
					if (i === arr.length - 1) {
						// handler: if sort order is not yet defined, make it big
						mw.__midwarePreExecuteSortOrder ??= Infinity;
					} else {
						// middleware: let's create some magic value, so we have some known boundary...
						// in other words, if we would ever need to manually set a mw position after normal ones,
						// we'll know to set a value greater than 1_000
						mw.__midwarePreExecuteSortOrder ??= 1_000;
					}
					return mw;
				});

			try {
				// this is likely a bug (while technically ok)
				if (!midwares.length) {
					throw new TypeError(`No DeminoHandler found`);
				}

				// create the midware
				const midware = new Midware<DeminoHandlerArgs>(midwares, {
					// we will sort the stack (see the dance above)
					preExecuteSortEnabled: true,
					// and we will check for duplicated middleware usage
					duplicatesCheckEnabled: true,
				});

				const _fullRoute = mountPath + route;
				_routers[method].assertIsValid(_fullRoute);

				_routers[method].on(_fullRoute, (params: Record<string, string>) => ({
					params,
					midware,
				}));

				if (options?.verbose) {
					log.debug(green(` ✔ ${method} ${mountPath + route}`));
				}
			} catch (e) {
				// this is a friendly warning not a fatal condition (other routes may work
				// fine, no need to die here)
				log.warn(red(` ✘ [Invalid] ${method} ${mountPath + route} (${e})`));
			}

			return _app;
		};

	// userland method api
	_app.all = _createRouteFn("ALL");
	_app.connect = _createRouteFn("CONNECT");
	_app.delete = _createRouteFn("DELETE");
	_app.get = _createRouteFn("GET");
	_app.head = _createRouteFn("HEAD");
	_app.options = _createRouteFn("OPTIONS");
	_app.patch = _createRouteFn("PATCH");
	_app.post = _createRouteFn("POST");
	_app.put = _createRouteFn("PUT");
	_app.trace = _createRouteFn("TRACE");

	// custom error handler
	_app.error = (handler: DeminoHandler) => {
		_errorHandler = handler;
		return _app;
	};

	// register middleware api
	_app.use = (...args: (string | DeminoHandler | DeminoHandler[])[]) => {
		const routes = args.filter((v) => typeof v === "string");
		const mws = args.filter((v) => typeof v !== "string");
		if (routes.length) {
			routes.forEach((r) => {
				_globalRouteMws[r] ??= [];
				_globalRouteMws[r].push(...mws.flat());
			});
		} else {
			_globalAppMws.push(...mws.flat());
		}
		return _app;
	};

	//
	_app.mountPath = () => mountPath;

	return _app;
}
