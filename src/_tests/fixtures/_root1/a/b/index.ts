// deno-lint-ignore-file no-explicit-any

import type { DeminoContext, DeminoHandler } from "../../../../../demino.ts";

export function GET(_r: Request, _i: Deno.ServeHandlerInfo, c: DeminoContext) {
	return "a/b|" + c.locals.mw.join();
}

//
GET.middlewares = [
	(_r: Request, _i: any, c: any) => {
		c.locals.mw ??= [];
		c.locals.mw.push("self:A/B");
	},
] as DeminoHandler[];

export function ALL(_r: Request, _i: Deno.ServeHandlerInfo, c: DeminoContext) {
	return "ALL:a/b|" + c.locals.mw.join();
}
