// deno-lint-ignore-file no-explicit-any

import {
	createHttpError,
	getErrorMessage,
	HTTP_STATUS,
} from "@marianmeres/http-utils";
import { Midware, type MidwareUseFn } from "@marianmeres/midware";
import { SimpleRouter } from "@marianmeres/simple-router";
import { green, red } from "@std/fmt/colors";

export interface DeminoContext {
	request: Request;
	info: Deno.ServeHandlerInfo;
	params: Record<string, string>;
	locals: Record<string, any>;
	__start: Date;
}

// prettier-ignore
// deno-fmt-ignore
export type ServeHandler = (req: Request, info: Deno.ServeHandlerInfo, context: DeminoContext) => Response | Promise<Response> | any;
export type MidsOrHandler = MidwareUseFn<DeminoContext>[] | ServeHandler;

// prettier-ignore
// deno-fmt-ignore
export interface Demino {
	(req: Request, info: Deno.ServeHandlerInfo): Response | Promise<Response>;
	get:    (route: string, midwaresOrHandler: MidsOrHandler, handler?: ServeHandler) => void;
	head:   (route: string, midwaresOrHandler: MidsOrHandler, handler?: ServeHandler) => void;
	put:    (route: string, midwaresOrHandler: MidsOrHandler, handler?: ServeHandler) => void;
	delete: (route: string, midwaresOrHandler: MidsOrHandler, handler?: ServeHandler) => void;
	post:   (route: string, midwaresOrHandler: MidsOrHandler, handler?: ServeHandler) => void;
	patch:  (route: string, midwaresOrHandler: MidsOrHandler, handler?: ServeHandler) => void;
	all:    (route: string, midwaresOrHandler: MidsOrHandler, handler?: ServeHandler) => void;
	error:  (handler: (req: Request, info: Deno.ServeHandlerInfo, error: any) => Response | Promise<Response> | any) => void;
	use:    (middleware: MidwareUseFn<DeminoContext>) => void;
	mountPath: () => string;
}

type Method = "GET" | "HEAD" | "PUT" | "DELETE" | "POST" | "PATCH";

// helper
const _isFn = (v: any): boolean => typeof v === "function";

// helper
function _assertValidRoute(v: string) {
	v = `${v}`.trim();
	if (v !== "" && (!v.startsWith("/") || v.includes("//"))) {
		throw new TypeError(
			`Route must be either empty, or start with a slash and must not contain double slashes.`
		);
	}
	return v;
}

/**
 * Main API.
 */
export function demino(
	mountPath: string = "",
	midwares: MidwareUseFn<DeminoContext>[] = [],
	options: Partial<{
		verbose: boolean;
	}> = {}
): Demino {
	//
	const _router = new SimpleRouter();
	let _errHandler: any;

	// prettier-ignore
	// deno-fmt-ignore
	const _errorResponse = async (req: Request, info: Deno.ServeHandlerInfo, e: any) => {
		let r;
		let wasFn = false;
		if (_isFn(_errHandler)) {
			wasFn = true;
			r = await _errHandler(req, info, e);
			// allow non Response err handler results which will get converted to string
			if (r !== undefined && !(r instanceof Response)) {
				r = new Response(`${r}`, { status: HTTP_STATUS.INTERNAL_SERVER_ERROR });
			}
		}
		if (!(r instanceof Response)) {
			wasFn && console.error(red(` --> [${req.method} ${req.url}] Error handler did not return a Response instance`));
			r = new Response(getErrorMessage(e) + "\n", { status: e?.status || HTTP_STATUS.INTERNAL_SERVER_ERROR });
		}
		return r;
	};

	const _createContext = (
		request: Request,
		info: Deno.ServeHandlerInfo,
		params: Record<string, string>
	): DeminoContext =>
		Object.freeze({
			request,
			info,
			params: Object.freeze(params),
			__start: new Date(),
			// userland write space
			locals: {},
		});

	//
	const _app = async (req: Request, info: Deno.ServeHandlerInfo) => {
		const method = req.method;
		const url = new URL(req.url);

		try {
			const matched = _router.exec(url.pathname + url.search);
			if (matched && [method, "ALL"].includes(matched.method)) {
				try {
					const context = _createContext(req, info, matched.params);
					const _mid = new Midware<DeminoContext>([
						...(midwares || []),
						...matched.midwares,
					]);
					// execute middlewares
					let result = await _mid.execute(context);

					// if any of the middlewares returned anything defined (and broke
					// the middlewares execution chain by doing so), keep it
					// without even executing the handler
					if (result === undefined) {
						// note that the handler may not be defined
						result = await matched.handler?.(req, info, context);
					}

					// if we have something other than Response, use it as a string body
					if (result !== undefined && !(result instanceof Response)) {
						result = new Response(`${result}`); // toString conversion
					}

					// still no Response?
					if (!(result instanceof Response)) {
						const msg = `Undefined handler result`;
						console.error(red(` --> [${req.method} ${req.url}] ${msg}`));
						throw TypeError(msg);
					}

					return result;
				} catch (e) {
					// prettier-ignore
					// deno-fmt-ignore
					throw createHttpError((e as any)?.status || HTTP_STATUS.INTERNAL_SERVER_ERROR, null, null, e);
				}
			} else {
				throw createHttpError(HTTP_STATUS.NOT_FOUND);
			}
		} catch (e) {
			return _errorResponse(req, info, e);
		}
	};

	//
	const _createHandler =
		(method: "ALL" | Method) =>
		(
			route: string,
			midwaresOrHandler: MidsOrHandler,
			handler?: ServeHandler
		) => {
			let midwares: MidwareUseFn<DeminoContext>[] = [];
			if (typeof midwaresOrHandler === "function") {
				handler = midwaresOrHandler;
			} else if (Array.isArray(midwaresOrHandler)) {
				midwares = midwaresOrHandler;
			}
			try {
				// at least one middleware or handler is considered formally OK (still no
				// guarantee that the actual request will be processed)
				if (!midwares.length && !_isFn(handler)) {
					throw new TypeError(`Neither middlewares nor handler specified`);
				}
				_router.on(
					_assertValidRoute(mountPath + route),
					(params: Record<string, string>) => ({
						params,
						handler,
						method,
						midwares,
					})
				);
				options?.verbose &&
					console.log(green(` ✔ ${method} ${mountPath + route}`));
			} catch (e) {
				// this is not considered fatal (all other routes may work fine), just letting know
				console.log(red(` ✘ [Invalid] ${method} ${mountPath + route} (${e})`));
			}
		};

	// userland api
	_app.get = _createHandler("GET");
	_app.head = _createHandler("HEAD");
	_app.put = _createHandler("PUT");
	_app.delete = _createHandler("DELETE");
	_app.post = _createHandler("POST");
	_app.patch = _createHandler("PATCH");
	_app.all = _createHandler("ALL");
	//
	_app.error = (handler: ServeHandler) => (_errHandler = handler);
	_app.mountPath = () => mountPath;
	_app.use = (middleware: MidwareUseFn<DeminoContext>) => {
		midwares.push(middleware);
	};

	return _app;
}

/**
 * Allows to compose multiple demino apps into a single serve handler.
 */
export function deminoCompose(apps: Demino[]): Deno.ServeHandler {
	return (req: Request, info: Deno.ServeHandlerInfo) => {
		let rootMount;

		for (const app of apps) {
			const url = new URL(req.url);
			const mountPath = app.mountPath();
			// mounted to topmost root empty string (first wins)
			if (!mountPath) {
				rootMount ??= app;
			} else if (url.pathname.startsWith(app.mountPath())) {
				return app(req, info);
			}
		}

		// was there any topmost mount?
		if (rootMount) {
			return rootMount(req, info);
		}

		// this will not be handled by any of the custom handlers
		return new Response("Not found", { status: HTTP_STATUS.NOT_FOUND });
	};
}
