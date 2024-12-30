// deno-lint-ignore-file no-explicit-any

import { HTTP_STATUS } from "@marianmeres/http-utils";
import { assertEquals } from "@std/assert";
import { trailingSlash } from "../../middleware/trailing-slash.ts";
import {
	assertResp,
	runTestServerTests,
	type TestServerTestsParams,
} from "../_utils.ts";

runTestServerTests([
	{
		name: "trailing slash manual redirect check",
		fn: async ({ app, base }: TestServerTestsParams) => {
			const tsOn = trailingSlash(true);
			const tsOff = trailingSlash(false);

			const globalMwOutput = "this must not be reached";
			app.use(() => globalMwOutput);
			app.get("/foo/bar", tsOn, () => "foo");
			app.get("/baz/bat", tsOff, () => "baz");
			app.get("/", tsOff, () => "home"); // root must be ignored

			const MP = HTTP_STATUS.MOVED_PERMANENTLY;
			const prm: any = { redirect: "manual" };

			// ON
			await assertResp(fetch(`${base}/foo/bar`, prm), MP, "", {
				location: /\/$/,
			});
			// OFF
			await assertResp(fetch(`${base}/baz/bat/`, prm), MP, "", {
				location: /[^\/]$/,
			});
			// NO-OP (it's correct that the global ms is reached here)
			await assertResp(fetch(`${base}`, prm), 200, globalMwOutput);
		},
	},
	{
		name: "trailing slash auto redirect",
		fn: async ({ app, base }: TestServerTestsParams) => {
			const _log: string[] = [];
			const logger = (v: string) => _log.push(v);

			const tsOn = trailingSlash(true, { logger });
			const tsOff = trailingSlash(false, { logger });

			app.get("/foo/bar", tsOn, () => "foo");
			app.get("/baz/bat", tsOff, () => "baz");

			// ON
			await assertResp(fetch(`${base}/foo/bar`), 200, "foo");
			await assertResp(fetch(`${base}/foo/bar/`), 200, "foo"); // no-op

			// OFF
			await assertResp(fetch(`${base}/baz/bat/`), 200, "baz");
			await assertResp(fetch(`${base}/baz/bat`), 200, "baz"); // no-op

			// the above 4 fetches must have triggered exactly 2 redirects (2 were no-ops)
			assertEquals(_log.length, 2);
		},
	},
]);
