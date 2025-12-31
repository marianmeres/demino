import type { DeminoContext, DeminoHandler } from "../../../../../src/demino.ts";

export function GET(_r: Request, _i: Deno.ServeHandlerInfo, c: DeminoContext) {
	return "a/b|" + (c.locals.mw as string[]).join();
}

//
GET.middlewares = [
	(_r: Request, _i: Deno.ServeHandlerInfo, c: DeminoContext) => {
		(c.locals.mw as string[]) ??= [];
		(c.locals.mw as string[]).push("self:A/B");
	},
] as DeminoHandler[];

export function ALL(_r: Request, _i: Deno.ServeHandlerInfo, c: DeminoContext) {
	return "ALL:a/b|" + (c.locals.mw as string[]).join();
}
