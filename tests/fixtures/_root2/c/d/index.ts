import type { DeminoContext, DeminoServeInfo } from "../../../../../src/demino.ts";

export function GET(_r: Request, _i: DeminoServeInfo, c: DeminoContext) {
	return "c/d|" + (c.locals.mw as string[]).join();
}

GET.middlewares = (_r: Request, _i: DeminoServeInfo, c: DeminoContext) => {
	(c.locals.mw as string[]) ??= [];
	(c.locals.mw as string[]).push("self:C/D");
};
