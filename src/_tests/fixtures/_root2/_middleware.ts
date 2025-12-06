// this middleware will be effective in _root1 (if used as combined)

import type { DeminoContext } from "../../../demino.ts";

export default [
	(_r: Request, _i: Deno.ServeHandlerInfo, c: DeminoContext) => {
		(c.locals.mw as string[]) ??= [];
		(c.locals.mw as string[]).push("/");
	},
];
