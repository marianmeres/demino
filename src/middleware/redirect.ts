import type { DeminoContext, DeminoHandler } from "../demino.ts";

/**
 * Will create a redirect middleware, which will `Response.redirect` to the provided `url`
 * with provided redirect `status` code.
 *
 * Only advantage over manual `Response.redirect` is that you can pass relative urls which
 * will otherwise be considered invalid.
 *
 * @example
 * ```ts
 * app.use('/old', redirect('/new', 301));
 * ```
 */
export function redirect(
	url: string | URL,
	status: 301 | 302 | 303 | 307 | 308 = 302
): DeminoHandler {
	return (req: Request, _info: Deno.ServeHandlerInfo, _ctx: DeminoContext) => {
		return Response.redirect(new URL(url, new URL(req.url)), status);
	};
}
