import type { DeminoContext } from "../../../demino.ts";

export function GET(_r: Request, _i: Deno.ServeHandlerInfo, c: DeminoContext) {
	return "/2|" + c.locals.mw.join();
}
