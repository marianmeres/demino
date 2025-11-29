import type { DeminoContext, DeminoHandler } from "../demino.ts";
import {
	type CookieOptions,
	parseCookies,
	serializeCookie,
} from "../utils/cookies.ts";

/**
 * Cookie helpers interface added to ctx.locals by the cookies middleware.
 */
export interface CookiesLocals {
	/** Parsed cookies from the request */
	cookies: Record<string, string>;
	/** Set a cookie in the response */
	setCookie: (name: string, value: string, options?: CookieOptions) => void;
	/** Delete a cookie by setting it with maxAge=0 */
	deleteCookie: (
		name: string,
		options?: { path?: string; domain?: string },
	) => void;
}

/**
 * Creates a cookies middleware that parses request cookies and provides
 * helpers for setting/deleting cookies in the response.
 *
 * Adds the following to `ctx.locals`:
 * - `cookies`: Parsed cookies from the request as key-value pairs
 * - `setCookie(name, value, options?)`: Set a response cookie
 * - `deleteCookie(name, options?)`: Delete a cookie
 *
 * @param defaults - Default cookie options applied to all setCookie calls
 * @returns Middleware handler
 *
 * @example Basic usage with defaults
 * ```ts
 * import { demino, cookies } from "@marianmeres/demino";
 *
 * const app = demino();
 * app.use(cookies({ httpOnly: true, secure: true, sameSite: "Lax", path: "/" }));
 *
 * app.get("/", (req, info, ctx) => {
 *   // Read cookies
 *   const sessionId = ctx.locals.cookies.session;
 *
 *   // Set a cookie (defaults are applied automatically)
 *   ctx.locals.setCookie("session", "abc123", { maxAge: 3600 });
 *
 *   // Override defaults when needed
 *   ctx.locals.setCookie("theme", "dark", { httpOnly: false });
 *
 *   return { ok: true };
 * });
 * ```
 *
 * @example Delete a cookie
 * ```ts
 * app.post("/logout", (req, info, ctx) => {
 *   ctx.locals.deleteCookie("session");
 *   return { loggedOut: true };
 * });
 * ```
 */
export function cookies(defaults?: CookieOptions): DeminoHandler {
	const midware: DeminoHandler = (
		req: Request,
		_info: Deno.ServeHandlerInfo,
		ctx: DeminoContext,
	) => {
		// Parse request cookies
		ctx.locals.cookies = parseCookies(req.headers.get("cookie"));

		// Helper to set a cookie (merges with defaults)
		ctx.locals.setCookie = (
			name: string,
			value: string,
			options?: CookieOptions,
		) => {
			ctx.headers.append(
				"set-cookie",
				serializeCookie(name, value, { ...defaults, ...options }),
			);
		};

		// Helper to delete a cookie (merges path/domain from defaults)
		ctx.locals.deleteCookie = (
			name: string,
			options?: { path?: string; domain?: string },
		) => {
			const { path, domain } = { ...defaults, ...options };
			ctx.headers.append(
				"set-cookie",
				serializeCookie(name, "", { path, domain, maxAge: 0 }),
			);
		};
	};

	// cookies middleware is duplicable (can be used multiple times if needed)
	midware.__midwareDuplicable = true;

	return midware;
}
