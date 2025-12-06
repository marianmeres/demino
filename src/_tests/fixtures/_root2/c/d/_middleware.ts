import type { DeminoContext } from "../../../../../demino.ts";

export default [
	(_r: Request, _i: Deno.ServeHandlerInfo, c: DeminoContext) => {
		(c.locals.mw as string[]) ??= [];
		(c.locals.mw as string[]).push("C/D");
	},
];
