import type { DeminoContext, DeminoHandler } from "../demino.ts";

/**
 * Creates a redirect middleware that redirects requests to a different URL.
 *
 * Supports both relative and absolute URLs. Relative URLs are resolved against
 * the current request URL, which is more convenient than `Response.redirect()`.
 *
 * Behind a TLS-terminating reverse proxy, the proxy→app hop is plain HTTP, so the
 * raw `req.url` scheme is `http:`. To avoid emitting an `http://` `Location` on an
 * HTTPS site, same-origin targets are emitted as a **relative** `Location` — the
 * client resolves it against the URL it actually used and keeps its `https`. This
 * is scheme-agnostic and needs no proxy-header trust. Cross-origin (external)
 * targets are emitted absolute and unchanged. "Same origin" is judged against
 * {@link DeminoContext.url} (proxy-aware when `trustProxy` is set).
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
	return (_req: Request, _info: Deno.ServeHandlerInfo, ctx: DeminoContext) => {
		// Resolve the target against the effective request URL — only to NORMALIZE
		// (e.g. "foo" -> "/base/foo") and to classify same- vs cross-origin. We
		// never emit the resolved scheme/host for a same-origin target.
		const target = new URL(url, ctx.url);
		const location = target.origin === ctx.url.origin
			? target.pathname + target.search + target.hash // relative: client keeps its scheme
			: target.href; // external: absolute, unchanged
		return new Response(null, { status, headers: { location } });
	};
}
