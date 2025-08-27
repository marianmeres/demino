import {
	createHttpError,
	getErrorMessage,
	HTTP_STATUS,
} from "@marianmeres/http-utils";
import { Midware, type MidwareUseFn } from "@marianmeres/midware";
import { green, red } from "@std/fmt/colors";
import { serveDir, type ServeDirOptions } from "@std/http/file-server";
import requestIp from "npm:request-ip@3";
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
	/** Client ip address */
	ip: string;
	/** Matched route definition */
	route: string;
	/** Will retrieve the current application logger (if any) */
	getLogger: () => DeminoLogger | null;
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

/** Info about regitered route and associated middleware count */
export type DeminoRouteMiddlewareInfo = Partial<
	Record<
		DeminoMethod | "ALL",
		{ localMiddlewaresCount: number; globalMiddlewaresCount: number }
	>
>;

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
	/** Will serve static files via `@std/http/serveDir` from the given `fsRoot` directory.  */
	static: (
		route: string,
		fsRoot: string,
		options?: Omit<ServeDirOptions, "fsRoot" | "urlRoot">
	) => Demino;
	/** Will re/un/set application logger */
	logger: (logger: DeminoLogger | null) => Demino;
	/** Will return debug info about registered routes and associated middlewares.
	 * Intended for debugging only. */
	info: () => {
		routes: Record<string, DeminoRouteMiddlewareInfo>;
		globalAppMiddlewaresCount: number;
	};
	/** Will return initial constructor options */
	getOptions: () => DeminoOptions;
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
	debug?: (...args: any[]) => void;
	log?: (...args: any[]) => void;
	warn?: (...args: any[]) => void;
	error?: (...args: any[]) => void;
	access?: (data: {
		timestamp: Date;
		status: number;
		req: Request;
		ip: string | undefined;
		duration: number;
	}) => void;
}

/** Internal DRY helper */
function isFn(v: any): boolean {
	return typeof v === "function";
}

/** Export few well known ones, for easier consumption in apps */
export const CONTENT_TYPE = {
	JSON: "application/json", // default encoding is utf-8
	TEXT: "text/plain; charset=utf-8",
	HTML: "text/html; charset=utf-8",
};

/** Creates Response based on body type */
function _createResponseFrom(
	req: Request,
	body: any,
	headers: Headers = new Headers(),
	status = HTTP_STATUS.OK
) {
	status ||= HTTP_STATUS.OK;

	// make no assumptions - empty body is technically valid
	if (body === undefined) {
		body = null;
		status = HTTP_STATUS.NO_CONTENT;
	} // JSON.stringify
	else if (
		// considering NULL a common DTO use case
		body === null ||
		// toJSON aware
		isFn(body?.toJSON) ||
		// plain array
		Array.isArray(body) ||
		// plain object without its own `toString` method
		(isPlainObject(body) &&
			!Object.prototype.hasOwnProperty.call(body, "toString"))
	) {
		body = JSON.stringify(body);
		if (!headers.has("content-type")) {
			headers.set("content-type", CONTENT_TYPE.JSON);
		}
	} // maybe any other auto detection here?
	// otherwise not much to guess anymore, simply cast to string
	else {
		body = `${body}`;
		if (!headers.has("content-type")) {
			headers.set("content-type", CONTENT_TYPE.HTML);
		}
	}

	// if we have a HEAD, do empty the body... (but no other changes). Intentionally
	// doing this step at the very bottom. Point is that we might have added the HEAD handler
	// automatically (byt "cloning" GET or ALL), so make sure we're not outputing anything.
	if (req.method === "HEAD") {
		body = null;
	}

	return new Response(body, { status, headers });
}

/** Internal DRY helper */
function _createContext(
	start: number,
	params: Record<string, string>,
	route: string,
	req: Request,
	info: Deno.ServeHandlerInfo,
	getLogger: () => DeminoLogger | null
): DeminoContext {
	const _clientIp = requestIp.getClientIp({
		headers: Object.fromEntries(req.headers), // requestIp needs plain object
	});
	return Object.seal({
		params: Object.freeze(params),
		route,
		locals: {},
		headers: new Headers(),
		error: null,
		status: HTTP_STATUS.OK,
		ip: _clientIp || (info?.remoteAddr as any)?.hostname,
		__start: new Date(start),
		getLogger,
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
	/** Application logger. Initially (if option not provided) will default to console.
	 * But can be later un/re/set via `app.logger(...)`. */
	logger?: DeminoLogger | undefined | null;
	/** As a convenience shortcut, you can pass in custom error handler directly in options */
	errorHandler?: DeminoHandler;
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
	// forcing conventional and composable behavior (see `deminoCompose` and URL.pathname)
	if (mountPath !== "" && !mountPath.startsWith("/")) {
		throw new TypeError(
			`Mount path must be either empty or must start with a slash (path: ${mountPath})`
		);
	}
	if (mountPath.endsWith("/")) {
		throw new TypeError(
			`Mount path must not end with a slash (path: ${mountPath})`
		);
	}
	if (/[\[\]:\*]/.test(mountPath)) {
		throw new TypeError(
			`Mount path must not contain dynamic segments (path: ${mountPath})`
		);
	}

	// initialize and normalize...
	const _globalAppMws = Array.isArray(middleware) ? middleware : [middleware];
	const _globalRouteMws: Record<string, DeminoHandler[]> = {};
	let _errorHandler: DeminoHandler;

	// initially we are falling back to console
	let _log: DeminoLogger | null =
		options?.logger === undefined ? console : options.logger;
	// but we can turn logging off altogether later if needed
	const getLogger = (): DeminoLogger | null => _log;

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

	// see `app.info`
	const _localMwsCounts: Record<
		string,
		Partial<Record<DeminoMethod | "ALL", number>>
	> = {};

	const _maybeSetXHeaders = (context: DeminoContext) => {
		if (!options?.noXPoweredBy && !context.headers.has("X-Powered-By")) {
			context.headers.set("X-Powered-By", `Demino`);
		}
		if (
			!options?.noXResponseTime &&
			!context.headers.has("X-Response-Time") &&
			isValidDate(context?.__start)
		) {
			context.headers.set(
				"X-Response-Time",
				`${Date.now() - context.__start.valueOf()}ms`
			);
		}
	};

	const _doLog = (type: keyof DeminoLogger, value: any) => {
		// make sure it is async, so it never effects responding
		return new Promise(() => {
			getLogger()?.[type]?.(value);
		});
	};

	//
	const _createErrorResponse = async (
		req: Request,
		info: Deno.ServeHandlerInfo,
		context: DeminoContext
	): Promise<Response> => {
		let r = await _errorHandler?.(req, info, context);
		if (!(r instanceof Response)) {
			_maybeSetXHeaders(context);
			// make sure to reset any content-type we might have (the factory below will set the proper one)
			context.headers.delete("content-type");
			r = _createResponseFrom(
				req,
				r || getErrorMessage(context.error),
				context.headers,
				context.error?.status || HTTP_STATUS.INTERNAL_SERVER_ERROR
			);
		}

		// always log all errors (except 404) unless not explicitly turned off via `.logger(null)`
		// to see 404s use access log
		if (r.status != 404) {
			_doLog("error", context.error);
		}

		return r;
	};

	const _accessLog = (data: {
		req: Request;
		status: number;
		start: number;
		ip: string;
	}) => {
		const { req, status, start, ip } = data;
		_doLog("access", {
			timestamp: new Date(),
			req,
			status,
			ip,
			duration: Date.now() - start,
		});
	};

	//
	const _app: Demino = async (req: Request, info: Deno.ServeHandlerInfo) => {
		const method: "ALL" | DeminoMethod = req.method as "ALL" | DeminoMethod;
		const url = new URL(req.url);
		const start = Date.now();
		let context = _createContext(start, {}, "", req, info, getLogger);

		// console.log("_app METHOD", method);

		try {
			if (!_routers[method]) {
				throw createHttpError(HTTP_STATUS.NOT_IMPLEMENTED);
			}

			let matched = _routers[method].exec(url.pathname);

			// if not matched, try ALL as a second attempt
			if (!matched && method !== "ALL") {
				matched = _routers.ALL.exec(url.pathname);
			}

			// special case not match for HEAD - if handler for some other method exist, we want 405, not 404
			if (!matched && method === "HEAD") {
				// prettier-ignore
				const ms: DeminoMethod[] = ["DELETE", "GET", "OPTIONS", "PATCH", "POST", "PUT"];
				if (ms.some((m) => _routers[m].exec(url.pathname))) {
					throw createHttpError(HTTP_STATUS.METHOD_NOT_ALLOWED);
				}
			}

			if (matched) {
				try {
					// prettier-ignore
					context = _createContext(start, matched.params, matched.route, req, info, getLogger);

					// everything is a middleware...
					const midwares: DeminoHandler[] = [
						..._globalAppMws,
						...(_globalRouteMws[matched.route] || []),
						...[...matched.midwares],
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

					// The core Demino business - execute all middlewares...
					// The intended convenient practice is actually NOT to return the Response
					// instance directly (unlike with Deno.ServeHandler)
					let result = await midware.execute([req, info, context]);

					//
					const headers = context?.headers || new Headers();

					// maybe some x-headers (this will work only if the result is not a Response instance)
					if (!(result instanceof Response)) {
						_maybeSetXHeaders(context);
					}

					// middleware returned error instead of throwing? Not a best practice, but possible...
					if (result instanceof Error) {
						context.error = result;
						result = await _createErrorResponse(req, info, context);
					} // we need Response instance eventually...
					else if (!(result instanceof Response)) {
						result = _createResponseFrom(req, result, headers, context?.status);
					}

					//
					const status = (result as Response).status;
					_accessLog({ req, status, start, ip: context.ip });

					//
					return result as Response;
				} catch (e: any) {
					const status = e.status || HTTP_STATUS.INTERNAL_SERVER_ERROR;
					throw createHttpError(status, null, null, e);
				}
			} else {
				throw createHttpError(HTTP_STATUS.NOT_FOUND);
			}
		} catch (e: any) {
			context.error = e;
			const resp = await _createErrorResponse(req, info, context);
			_accessLog({ req, status: resp.status, start, ip: context.ip });
			return resp;
		}
	};

	//
	const _createRouteFn = (method: "ALL" | DeminoMethod): DeminoRouteHandler => {
		return (
			route: string,
			...args: (DeminoHandler | DeminoHandler[])[]
		): Demino => {
			const _fullRoute = mountPath + route;

			// wrap the provided as array, so we can DRY handle "head" special case below
			const _methods = [method];

			// so, for every GET auto add HEAD
			if (["GET", "ALL"].includes(method)) {
				_methods.push("HEAD");
			}

			for (const method of _methods) {
				try {
					//
					_routers[method].assertIsValid(_fullRoute);

					_routers[method].on(_fullRoute, (params: Record<string, string>) => ({
						params,
						midwares: args,
						route: _fullRoute,
					}));

					_localMwsCounts[_fullRoute] ??= {};
					_localMwsCounts[_fullRoute][method] = args.flat().length - 1;

					if (options?.verbose) {
						_doLog("debug", green(` ✔ ${method} ${mountPath + route}`));
					}
				} catch (e) {
					// this is a friendly warning not a fatal condition (other routes may work fine)
					_doLog("warn", red(` ✘ [Invalid] ${method} ${_fullRoute} (${e})`));
				}
			}

			return _app;
		};
	};

	// userland method api
	_app.all = _createRouteFn("ALL");
	_app.connect = _createRouteFn("CONNECT");
	_app.delete = _createRouteFn("DELETE");
	_app.get = _createRouteFn("GET");
	_app.head = (...args) => {
		console.warn(
			"WARN: Are you sure to implement a custom HEAD request handler? " +
				"HEAD requests are handled automatically in Demino by default (as long as GET handler exists)."
		);
		return _createRouteFn("HEAD")(...args);
	};
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
				r = mountPath + r;
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

	// experimental and ugly
	_app.static = (
		route: string,
		fsRoot: string,
		options?: Omit<ServeDirOptions, "fsRoot" | "urlRoot">
	) => {
		// probably hackish-ly doable, but not worth the dance... (what for, anyway)
		if (/[\[\]:\*]/.test(route)) {
			throw new TypeError(
				`Static route must not contain dynamic segments (route: ${route})`
			);
		}
		let urlRoot: string;

		// make sure we're passing a catch-all route (will work fine with simple-router)
		if (!route.endsWith("/*")) {
			urlRoot = mountPath + route;
			route = `${route}/*`.replace(/\/+/g, "/");
		} else {
			urlRoot = (mountPath + route).slice(0, -2);
		}

		urlRoot = urlRoot.slice(1); // strip leading slash
		// console.log(123, route, urlRoot);

		_app.all(route, (req) => {
			return serveDir(req, {
				...(options || { quiet: true }),
				fsRoot,
				urlRoot,
			});
		});

		return _app;
	};

	if (options?.errorHandler) {
		_app.error(options.errorHandler);
	}

	// un/re/set application logger
	_app.logger = (logger: DeminoLogger | null) => {
		_log = logger;
		return _app;
	};

	// prettier-ignore
	// deno-fmt-ignore
	_app.info = () => {
		const routes: Record<string, DeminoRouteMiddlewareInfo> = {};
		Object.entries(_routers).forEach((entry) => {
			const [m, router] = entry as [DeminoMethod | "ALL", DeminoRouter];
			router.info().forEach((r) => {
				routes[r] ??= {};
				routes[r][m] ??= { localMiddlewaresCount: 0, globalMiddlewaresCount: 0 };
				routes[r][m].globalMiddlewaresCount = _globalRouteMws[r]?.length || 0;
				routes[r][m].localMiddlewaresCount = _localMwsCounts?.[r]?.[m] || 0;
			});
		});
		return { routes, globalAppMiddlewaresCount: _globalAppMws.length };
	};

	_app.getOptions = () => options ?? {};

	//
	return _app;
}
