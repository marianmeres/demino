import type { DeminoContext } from "../../../../../../src/demino.ts";

export function GET(_r: Request, _i: Deno.ServeHandlerInfo, c: DeminoContext) {
	return "a/b/c|" + (c.locals.mw as string[]).join();
}
