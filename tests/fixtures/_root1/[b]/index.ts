import type { DeminoContext } from "../../../../src/demino.ts";

export function GET(
	_r: Request,
	_i: Deno.ServeHandlerInfo,
	ctx: DeminoContext,
) {
	return ctx.params;
}
