import { HTTP_STATUS } from "@marianmeres/http-utils";
import type { DeminoContext, DeminoHandler } from "../demino.ts";

/**
 * Configuration options for CORS middleware.
 * All options support static values, arrays, or dynamic functions for fine-grained control.
 */
export interface CorsOptions {
	/**
	 * Allowed origins for cross-origin requests.
	 * @default "*"
	 */
	allowOrigin:
		| string
		| string[]
		| ((origin: string, headers: Headers) => string | Promise<string>);

	/**
	 * Allowed HTTP methods for CORS requests.
	 * @default "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS"
	 */
	allowMethods:
		| string
		| string[]
		| ((origin: string, headers: Headers) => string | Promise<string>);

	/**
	 * Allowed request headers.
	 * @default "Content-Type,Authorization"
	 */
	allowHeaders:
		| string
		| string[]
		| ((origin: string, headers: Headers) => string | Promise<string>);

	/**
	 * Whether to allow credentials (cookies, authorization headers).
	 * @default true
	 */
	allowCredentials:
		| boolean
		| ((origin: string, headers: Headers) => boolean | Promise<boolean>);

	/**
	 * Maximum age (in seconds) for preflight cache.
	 * @default 86400 (24 hours)
	 */
	maxAge:
		| number
		| ((origin: string, headers: Headers) => number | Promise<number>);
}

/**
 * Creates a CORS (Cross-Origin Resource Sharing) middleware.
 *
 * Sets appropriate CORS headers in the response and handles preflight OPTIONS requests.
 * By default, uses permissive settings (allows all origins and credentials).
 *
 * @param options - CORS configuration (all fields optional)
 * @returns Middleware handler that sets CORS headers
 *
 * @example Basic usage with defaults
 * ```ts
 * import { cors } from "@marianmeres/demino";
 *
 * app.use(cors());
 * app.options("*", cors()); // Handle preflight requests
 * ```
 *
 * @example Static whitelist
 * ```ts
 * app.use(cors({
 *   allowOrigin: ["https://example.com", "https://app.example.com"],
 *   allowCredentials: true
 * }));
 * ```
 *
 * @example Dynamic origin validation
 * ```ts
 * app.use(cors({
 *   allowOrigin: (origin, headers) => {
 *     return myWhitelist.includes(origin) ? origin : "";
 *   },
 *   allowCredentials: true
 * }));
 * ```
 *
 * @example Custom headers and methods
 * ```ts
 * app.use(cors({
 *   allowMethods: ["GET", "POST"],
 *   allowHeaders: ["Content-Type", "X-Custom-Header"],
 *   maxAge: 3600 // 1 hour preflight cache
 * }));
 * ```
 */
export function cors(options?: Partial<CorsOptions>): DeminoHandler {
	const {
		allowOrigin = "*",
		allowMethods = "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS",
		allowHeaders = "Content-Type,Authorization", // '*'
		allowCredentials = true,
		maxAge = 86_400, // 24 hours
	} = options ?? {};

	const midware: DeminoHandler = async (
		req: Request,
		_info: Deno.ServeHandlerInfo,
		ctx: DeminoContext,
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
			// browsers may not support wildcard with allow-credentials, so:
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

	// cors is duplicable
	midware.__midwareDuplicable = true;

	return midware;
}
