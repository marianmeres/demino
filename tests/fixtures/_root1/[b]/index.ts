import type { DeminoContext, DeminoServeInfo } from "../../../../src/demino.ts";

export function GET(_r: Request, _i: DeminoServeInfo, ctx: DeminoContext) {
	return ctx.params;
}
