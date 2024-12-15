import type { DeminoContext } from "../../../../demino.ts";

export function GET(
	_r: Request,
	_i: Deno.ServeHandlerInfo,
	ctx: DeminoContext
) {
	return ctx.params;
}
