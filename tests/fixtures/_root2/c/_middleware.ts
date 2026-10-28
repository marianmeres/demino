import type { DeminoContext, DeminoServeInfo } from "../../../../src/demino.ts";

export default [
	(_r: Request, _i: DeminoServeInfo, c: DeminoContext) => {
		(c.locals.mw as string[]) ??= [];
		(c.locals.mw as string[]).push("C");
	},
];
