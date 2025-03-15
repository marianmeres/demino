import { HTTP_STATUS } from "@marianmeres/http-utils";
import type { DeminoContext, DeminoHandler } from "../demino.ts";

export interface CorsOptions {
	allowOrigin:
		| string
		| string[]
		| ((origin: string, headers: Headers) => string | Promise<string>);
	allowMethods:
		| string
		| string[]
		| ((origin: string, headers: Headers) => string | Promise<string>);
	allowHeaders:
		| string
		| string[]
		| ((origin: string, headers: Headers) => string | Promise<string>);
	allowCredentials:
		| boolean
		| ((origin: string, headers: Headers) => boolean | Promise<boolean>);
	maxAge:
		| number
		| ((origin: string, headers: Headers) => number | Promise<number>);
}

/**
 * Will create the "Cross-origin resource sharing" ("CORS") headers in the response
 * based on the provided config.
 *
 * @example Default options
 * ```ts
 * app.use(cors()); // default
 * ```
 *
 * @example Dynamic eval
 * ```ts
 * app.use(cors({
 *     allowOrigin: (origin: string, reqHeaders: Headers) => {
 *         return (myWhitelist.includes(origin)) ? origin : "";
 *     }
 * }));
 * ```
 */
export function cors(options?: Partial<CorsOptions>): DeminoHandler {
	const {
		allowOrigin = "*",
		allowMethods = "GET,HEAD,PUT,PATCH,POST,DELETE",
		allowHeaders = "Content-Type,Authorization",
		allowCredentials = false,
		maxAge = 86_400, // 24 hours
	} = options ?? {};

	return async (
		req: Request,
		_info: Deno.ServeHandlerInfo,
		ctx: DeminoContext
	) => {
		const requestOrigin = req.headers.get("origin") || "";

		// credentials
		let credentials: boolean;
		if (typeof allowCredentials === "function") {
			credentials = await allowCredentials(requestOrigin, req.headers);
		} else {
			credentials = allowCredentials;
		}
		if (credentials) {
			ctx.headers.set("Access-Control-Allow-Credentials", "true");
		}

		// origin
		let origin;
		if (typeof allowOrigin === "function") {
			origin = await allowOrigin(requestOrigin, req.headers);
		} else if (Array.isArray(allowOrigin)) {
			origin = allowOrigin.includes(requestOrigin) ? requestOrigin : null;
		} else {
			origin = allowOrigin;
		}
		if (origin) {
			// browsers do not support wildcard with allow-credentials, so:
			if (credentials && origin === "*" && requestOrigin) {
				origin = requestOrigin;
			}
			ctx.headers.set("Access-Control-Allow-Origin", origin);
		}

		// methods
		let methods: string;
		if (typeof allowMethods === "function") {
			methods = await allowMethods(requestOrigin, req.headers);
			if (Array.isArray(methods)) methods = methods.join(",");
		} else if (Array.isArray(allowMethods)) {
			methods = allowMethods.join(",");
		} else {
			methods = allowMethods;
		}
		ctx.headers.set("Access-Control-Allow-Methods", methods);

		// headers
		let headers: string;
		if (typeof allowHeaders === "function") {
			headers = await allowHeaders(requestOrigin, req.headers);
			if (Array.isArray(headers)) headers = headers.join(",");
		} else if (Array.isArray(allowHeaders)) {
			headers = allowHeaders.join(",");
		} else {
			headers = allowHeaders;
		}
		ctx.headers.set("Access-Control-Allow-Headers", headers);

		// preflight max age
		let _maxAge;
		if (typeof maxAge === "function") {
			_maxAge = await maxAge(requestOrigin, req.headers);
		} else {
			_maxAge = maxAge;
		}
		if (_maxAge) {
			ctx.headers.set("Access-Control-Max-Age", `${_maxAge}`);
		}

		// preflight requests
		if (req.method === "OPTIONS") {
			ctx.status = HTTP_STATUS.NO_CONTENT;
			return;
		}
	};
}
