import type {
	DeminoContext,
	DeminoHandler,
	DeminoServeInfo,
} from "../../../../src/demino.ts";

export function GET(
	_req: Request,
	_info: DeminoServeInfo,
	_ctx: DeminoContext,
) {
	return "I will not be matched";
}

GET._middlewares = [] as DeminoHandler[];
