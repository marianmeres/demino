import type { DeminoContext, DeminoServeInfo } from "../../../../../../src/demino.ts";

export function GET(_r: Request, _i: DeminoServeInfo, c: DeminoContext) {
	return "a/b/c|" + (c.locals.mw as string[]).join();
}
