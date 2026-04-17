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
		| ((
			origin: string,
			headers: Headers,
		) => string | string[] | Promise<string | string[]>);

	/**
	 * Allowed request headers.
	 * @default "Content-Type,Authorization"
	 */
	allowHeaders:
		| string
		| string[]
		| ((
			origin: string,
			headers: Headers,
		) => string | string[] | Promise<string | string[]>);

	/**
	 * Whether to allow credentials (cookies, authorization headers).
	 *
	 * Defaults to `false` (since 1.7.0) — the CORS spec forbids combining
	 * credentialed requests with `allowOrigin: "*"`, and the previous default
	 * (`true`) silently echoed back any request `Origin` to work around that,
	 * effectively allowing credentialed requests from any origin.
	 *
	 * Enable this only with an explicit `allowOrigin` allowlist (string or
	 * function) — passing both `allowCredentials: true` AND `allowOrigin: "*"`
	 * will throw at construction time.
	 *
	 * @default false
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
 * Defaults: `allowOrigin: "*"`, `allowCredentials: false`. To allow credentialed
 * requests, supply an explicit allowlist (string, string[], or function returning the
 * matched origin); the wildcard + credentials combination is forbidden by the CORS spec
 * and rejected at construction time.
 *
 * @param options - CORS configuration (all fields optional)
 * @returns Middleware handler that sets CORS headers
 *
 * @example Basic public-read usage (no credentials)
 * ```ts
 * import { cors } from "@marianmeres/demino";
 *
 * app.use(cors());
 * app.options("*", cors()); // Handle preflight requests
 * ```
 *
 * @example Static whitelist with credentials
 * ```ts
 * app.use(cors({
 *   allowOrigin: ["https://example.com", "https://app.example.com"],
 *   allowCredentials: true
 * }));
 * ```
 *
 * @example Dynamic origin validation with credentials
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
		allowCredentials = false,
		maxAge = 86_400, // 24 hours
	} = options ?? {};

	// Refuse the spec-violating combination at construction time. We can only
	// catch the static case here; for dynamic `allowOrigin` / `allowCredentials`
	// functions, the per-request branch below silently disables credentials when
	// the resolved origin is `*` (and warns once via console).
	if (allowOrigin === "*" && allowCredentials === true) {
		throw new TypeError(
			"cors(): `allowCredentials: true` is incompatible with " +
				'`allowOrigin: "*"`. Provide an explicit allowlist (string, ' +
				"string[], or function returning the matched origin), or set " +
				"`allowCredentials: false`. See https://fetch.spec.whatwg.org/#cors-protocol-and-credentials.",
		);
	}

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
		let originVaries = false;
		if (typeof allowOrigin === "function") {
			origin = await allowOrigin(requestOrigin, req.headers);
			originVaries = true;
		} else if (Array.isArray(allowOrigin)) {
			origin = allowOrigin.includes(requestOrigin) ? requestOrigin : null;
			originVaries = true;
		} else {
			origin = allowOrigin;
		}
		if (origin) {
			// Spec-violating combination: `Access-Control-Allow-Origin: *` is
			// incompatible with `Access-Control-Allow-Credentials: true`. The
			// constructor catches the static-config case; this branch handles
			// the case where a dynamic `allowOrigin` / `allowCredentials`
			// function resolved to that combination at request time.
			//
			// Refuse to send the headers at all so the browser-side preflight
			// fails closed instead of us silently echoing back an arbitrary
			// request `Origin` (which would amount to allowing every origin).
			if (credentials && origin === "*") {
				ctx.getLogger()?.warn?.(
					"[cors] Refusing to set headers: dynamic `allowOrigin` " +
						"resolved to '*' while `allowCredentials` is true. " +
						"Return a specific origin (or set credentials to false).",
				);
				ctx.headers.delete("Access-Control-Allow-Credentials");
			} else {
				ctx.headers.set("Access-Control-Allow-Origin", origin);
				if (originVaries) {
					ctx.headers.append("Vary", "Origin");
				}
			}
		}

		// methods
		let methods: string;
		if (typeof allowMethods === "function") {
			const result = await allowMethods(requestOrigin, req.headers);
			methods = Array.isArray(result) ? result.join(",") : result;
		} else if (Array.isArray(allowMethods)) {
			methods = allowMethods.join(",");
		} else {
			methods = allowMethods;
		}
		ctx.headers.set("Access-Control-Allow-Methods", methods);

		// headers
		let headers: string;
		if (typeof allowHeaders === "function") {
			const result = await allowHeaders(requestOrigin, req.headers);
			headers = Array.isArray(result) ? result.join(",") : result;
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
