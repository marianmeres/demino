// deno-lint-ignore-file no-explicit-any

import {
	createHttpError,
	getErrorMessage,
	HTTP_STATUS,
} from "@marianmeres/http-utils";
import { Midware } from "@marianmeres/midware";
import { SimpleRouter } from "@marianmeres/simple-router";
import { green, red } from "@std/fmt/colors";

/** Object passed as a last (3rd) parameter to middleware fns AND route handlers */
export interface DeminoContext {
	/** route's parsed params (merged path named segments AND query vars) */
	params: Record<string, string>;
	/** userland read/write key-value map */
	locals: Record<string, any>;
	/** custom userland response (!) headers to be used in the final output */
	headers: Headers;
	/** internal: timestamp of the incoming request */
	__start: Date;
}

/** Demino route handler AND middlware fn (both are of the same type) */
export type DeminoHandler = (
	req: Request,
	info: Deno.ServeHandlerInfo,
	context: DeminoContext
) => any;

/** Express-like route handler definition */
export type DeminoRouteFn = (
	route: string,
	...args: (DeminoHandler | DeminoHandler[])[]
) => void;

/** Error handler */
export type DeminoErrorHandler = (
	req: Request,
	info: Deno.ServeHandlerInfo,
	error: any,
	/** the headers to use in Response */
	headers: Headers
) => any;

/** Demino app */
export interface Demino extends Deno.ServeHandler {
	/** HTTP GET route handler definition */
	get: DeminoRouteFn;
	/** HTTP HEAD route handler definition */
	head: DeminoRouteFn;
	/** HTTP PUT route handler definition */
	put: DeminoRouteFn;
	/** HTTP DELETE route handler definition */
	delete: DeminoRouteFn;
	/** HTTP POST route handler definition */
	post: DeminoRouteFn;
	/** HTTP PATCH route handler definition */
	patch: DeminoRouteFn;
	/** Special case _every_ HTTP method route handler definition */
	all: DeminoRouteFn;
	/** Custom error handler definition */
	error: (handler: DeminoErrorHandler) => void;
	/** Global middleware addon */
	use: (middleware: DeminoHandler | DeminoHandler[]) => void;
	/** Return which path is the current app mounted on */
	mountPath: () => string;
}

/** Supported methods */
type Method = "GET" | "HEAD" | "PUT" | "DELETE" | "POST" | "PATCH";

/** For the possible future console alternatives... */
export interface DeminoLogger {
	error: (...args: any[]) => void;
	warn: (...args: any[]) => void;
	log: (...args: any[]) => void;
	debug: (...args: any[]) => void;
}

/** Internal helper */
function _isFn(v: any): boolean {
	return typeof v === "function";
}

/** Internal helper */
function _isPlainObject(v: any): boolean {
	return Object.prototype.toString.call(v) === "[object Object]";
}

/** Internal helper */
function _isValidDate(v: any) {
	return v instanceof Date && !isNaN(v.getTime());
}

/** Asserts that route meets internal validation criteria */
function _assertValidRoute(v: string) {
	v = `${v}`.trim();
	if (v !== "" && (!v.startsWith("/") || v.includes("//"))) {
		throw new TypeError(
			`Route must be either empty, or start with a slash and must not contain double slashes.`
		);
	}
	return v;
}

/** Creates Response based on body type */
function _createResponseFrom(body: any, headers: Headers = new Headers()) {
	let status = HTTP_STATUS.OK;

	// make no assumptions - empty body is technically valid
	if (body === undefined) {
		body = null;
		status = HTTP_STATUS.NO_CONTENT;
	}
	// json if plain object or toJSON aware (but ignoring json valid primitives, except for NULL)
	else if (body === null || _isPlainObject(body) || _isFn(body?.toJSON)) {
		body = JSON.stringify(body);
		headers.set("Content-Type", "application/json; charset=utf-8");
	}
	// todo: maybe anything else here?
	// else if (...) {}
	// otherwise not much to guess anymore, simply cast to string
	else {
		body = `${body}`;
	}

	return new Response(body, { status, headers });
}

/** Internal helper */
function _createContext(params: Record<string, string>): DeminoContext {
	return Object.freeze({
		params: Object.freeze(params),
		locals: {},
		headers: new Headers(),
		__start: new Date(),
	});
}

/**
 * Creates the Demino app, which is a valid `Deno.serve` handler function.
 */
export function demino(
	mountPath: string = "",
	middleware: DeminoHandler | DeminoHandler[] = [],
	options: Partial<{
		verbose: boolean;
		logger: DeminoLogger;
		noXPoweredBy: boolean;
		noXResponseTime: boolean;
	}> = {}
): Demino {
	// initialize and normalize...
	let _middlewares = Array.isArray(middleware) ? middleware : [middleware];
	const log = options?.logger ?? console;
	const _router = new SimpleRouter();
	let _errorHandler: DeminoErrorHandler;

	//
	const _createErrorResponse = async (
		req: Request,
		info: Deno.ServeHandlerInfo,
		e: any,
		headers: Headers = new Headers()
	) => {
		let r = await _errorHandler?.(req, info, e, headers);
		if (!(r instanceof Response)) {
			r = new Response(getErrorMessage(e), {
				status: e?.status || HTTP_STATUS.INTERNAL_SERVER_ERROR,
				headers,
			});
		}
		return r;
	};

	//
	const _app: Demino = async (req: Request, info: Deno.ServeHandlerInfo) => {
		const method = req.method;
		const url = new URL(req.url);

		try {
			const matched = _router.exec(url.pathname + url.search);
			if (matched && [method, "ALL"].includes(matched.method)) {
				try {
					const context = _createContext(matched.params);
					const _mid = new Midware<
						[Request, Deno.ServeHandlerInfo, DeminoContext]
					>([...(_middlewares || []), ...matched.midwares]);

					// The core Demino business - execute all middlewares...
					// The intended convenient practice is actually NOT to return the Response
					// instance directly (unlike with Deno.ServeHandler)
					let result = await _mid.execute([req, info, context]);

					//
					const headers = context?.headers || new Headers();

					// maybe some x-headers (this will work only if the result is not
					// a Response instance, otherwise we would need to clone it...)
					if (!(result instanceof Response)) {
						if (!options.noXPoweredBy) {
							headers.set("X-Powered-By", `Demino`);
						}

						if (!options.noXResponseTime && _isValidDate(context?.__start)) {
							headers.set(
								"X-Response-Time",
								`${new Date().valueOf() - context.__start.valueOf()}ms`
							);
						}
					}

					// middleware returned error instead of throwing? Weird, but possible...
					if (result instanceof Error) {
						result = _createErrorResponse(req, info, result, headers);
					}
					// we need Response instance eventually...
					else if (!(result instanceof Response)) {
						// this is the intended practice to build the Response automatically
						result = _createResponseFrom(result, headers);
					}

					return result;
				} catch (e: any) {
					const status = e.status || HTTP_STATUS.INTERNAL_SERVER_ERROR;
					throw createHttpError(status, null, null, e);
				}
			} else {
				throw createHttpError(HTTP_STATUS.NOT_FOUND);
			}
		} catch (e) {
			return _createErrorResponse(req, info, e);
		}
	};

	//
	const _createRouteFn =
		(method: "ALL" | Method): DeminoRouteFn =>
		(route: string, ...args: (DeminoHandler | DeminoHandler[])[]): void => {
			// everything is a middleware...
			const midwares = [..._middlewares, ...args].flat().filter(Boolean);

			try {
				// this is likely a bug (while technically ok)
				if (!midwares.length) {
					throw new TypeError(`No DeminoHandler found`);
				}

				_router.on(
					_assertValidRoute(mountPath + route),
					(params: Record<string, string>) => ({ params, method, midwares })
				);

				if (options?.verbose) {
					log.debug(green(` ✔ ${method} ${mountPath + route}`));
				}
			} catch (e) {
				// this is a friendly warning not a fatal condition (other routes may work
				// fine, no need to die here)
				log.warn(red(` ✘ [Invalid] ${method} ${mountPath + route} (${e})`));
			}
		};

	// userland method apis
	_app.get = _createRouteFn("GET");
	_app.head = _createRouteFn("HEAD");
	_app.put = _createRouteFn("PUT");
	_app.delete = _createRouteFn("DELETE");
	_app.post = _createRouteFn("POST");
	_app.patch = _createRouteFn("PATCH");
	_app.all = _createRouteFn("ALL");

	// other
	_app.error = (handler: DeminoErrorHandler) => (_errorHandler = handler);
	_app.mountPath = () => mountPath;
	_app.use = (middleware: DeminoHandler | DeminoHandler[]) => {
		_middlewares = [
			..._middlewares,
			...(Array.isArray(middleware) ? middleware : [middleware]),
		];
	};

	return _app;
}

/**
 * Allows to compose multiple demino apps into a single one.
 */
export function deminoCompose(
	apps: Demino[],
	notFoundHandler?: (
		req: Request,
		info: Deno.ServeHandlerInfo
	) => Response | Promise<Response>
): Deno.ServeHandler {
	// helper to normalize paths as "/di/r/s/"
	const _slashed = (s: string) => {
		if (!s.startsWith("/")) s = "/" + s;
		if (!s.endsWith("/")) s += "/";
		return s;
	};

	// in case of the same mountPaths, the later wins
	const mounts = apps.reduce(
		(m, a) => ({ ...m, [_slashed(a.mountPath() || "/")]: a }),
		{} as Record<string, Demino>
	);
	// console.log(Object.keys(mounts));

	notFoundHandler ??= () => new Response("Not Found...", { status: 404 });

	// return composed Deno.ServeHandler
	return (req: Request, info: Deno.ServeHandlerInfo) => {
		const url = new URL(req.url);

		// root special case
		if ("/" === url.pathname) {
			return mounts["/"]?.(req, info) ?? notFoundHandler(req, info);
		}

		// now start cutting off path segments from the right, and try to match
		// against the mapped mount paths. This may not be 100% perfect in wild
		// route and mount path scenarios, but is extremely cheap and should just get the
		// job done in most cases.
		let pathname = url.pathname;
		let pos = pathname.lastIndexOf("/");
		while (pos > 0) {
			pathname = pathname.slice(0, pos);
			pos = pathname.lastIndexOf("/");
			const key = _slashed(pathname);
			if (mounts[key]) return mounts[key](req, info);
		}

		// fallback to root mount (if available)...
		return mounts["/"]?.(req, info) ?? notFoundHandler(req, info);
	};
}
