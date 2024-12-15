import type { DeminoContext } from "../../../../../demino.ts";

export function GET(_r: Request, _i: Deno.ServeHandlerInfo, c: DeminoContext) {
	return "c/d|" + c.locals.mw.join();
}

GET.middlewares = (_r: Request, _i: any, c: any) => {
	c.locals.mw ??= [];
	c.locals.mw.push("self:C/D");
};
