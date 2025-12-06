import type { DeminoContext } from "../../../../../demino.ts";

export function GET(_r: Request, _i: Deno.ServeHandlerInfo, c: DeminoContext) {
	return "c/d|" + (c.locals.mw as string[]).join();
}

GET.middlewares = (_r: Request, _i: Deno.ServeHandlerInfo, c: DeminoContext) => {
	(c.locals.mw as string[]) ??= [];
	(c.locals.mw as string[]).push("self:C/D");
};
