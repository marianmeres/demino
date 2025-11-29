import type { DeminoContext, DeminoHandler } from "../demino.ts";

/**
 * Creates a redirect middleware that redirects requests to a different URL.
 *
 * Supports both relative and absolute URLs. Relative URLs are resolved against
 * the current request URL, which is more convenient than Response.redirect().
 *
 * @param url - Target URL (relative or absolute)
 * @param status - HTTP redirect status code (default: 302 Found)
 * @returns Middleware handler that performs the redirect
 *
 * @example Permanent redirect
 * ```ts
 * import { redirect } from "@marianmeres/demino";
 *
 * app.use("/old-path", redirect("/new-path", 301));
 * ```
 *
 * @example Temporary redirect (default)
 * ```ts
 * app.use("/temp", redirect("/current"));
 * ```
 *
 * @example Absolute URL redirect
 * ```ts
 * app.use("/external", redirect("https://example.com", 302));
 * ```
 */
export function redirect(
	url: string | URL,
	status: 301 | 302 | 303 | 307 | 308 = 302,
): DeminoHandler {
	return (req: Request, _info: Deno.ServeHandlerInfo, _ctx: DeminoContext) => {
		return Response.redirect(new URL(url, new URL(req.url)), status);
	};
}
