import type { DeminoContext, DeminoServeInfo } from "../../../src/demino.ts";

export function GET(_r: Request, _i: DeminoServeInfo, c: DeminoContext) {
	return "/2|" + (c.locals.mw as string[]).join();
}
