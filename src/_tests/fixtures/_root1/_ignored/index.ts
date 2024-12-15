import type { DeminoContext, DeminoHandler } from "../../../../demino.ts";

export function GET(
	_req: Request,
	_info: Deno.ServeHandlerInfo,
	_ctx: DeminoContext
) {
	return "I will not be matched";
}

GET._middlewares = [] as DeminoHandler[];
