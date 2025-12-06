import { HTTP_STATUS } from "@marianmeres/http-utils";
import { assertEquals } from "@std/assert";
import { trailingSlash } from "../../src/middleware/trailing-slash.ts";
import { assertResp, runTestServerTests } from "../_utils.ts";

runTestServerTests([
	{
		name: "trailing slash manual redirect check",
		fn: async ({ app, base }) => {
			const tsOn = trailingSlash(true);
			const tsOff = trailingSlash(false);

			const globalMwOutput = "this must not be reached";
			app.use(() => globalMwOutput);
			app.get("/foo/bar", tsOn, () => "foo");
			app.get("/baz/bat", tsOff, () => "baz");
			app.get("/", tsOff, () => "home"); // root must be ignored

			const MP = HTTP_STATUS.MOVED_PERMANENTLY;
			const prm: RequestInit = { redirect: "manual" };

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
		fn: async ({ app, base }) => {
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
	{
		name: "trailing slash is inactive on other than GET or file-like endpoints",
		fn: async ({ app, base }) => {
			let _log: string[] = [];
			const logger = (v: string) => _log.push(v);

			const tsOn = trailingSlash(true, { logger });

			app.use(tsOn);

			app.all("/foo", () => "foo");
			app.all("/foo/bar.baz", () => "bar.baz");
			app.all("/file.txt", () => "file.txt");

			// normal get must work
			await assertResp(fetch(`${base}/foo`), 200, "foo");
			assertEquals(_log.length, 1);

			// any other than get must be a noop
			for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
				_log = [];
				await assertResp(fetch(`${base}/foo`, { method }), 200, "foo");
				assertEquals(_log.length, 0);
			}

			// if it looks like a file, noop
			await assertResp(fetch(`${base}/foo/bar.baz`), 200, "bar.baz");
			assertEquals(_log.length, 0);

			await assertResp(fetch(`${base}/file.txt`), 200, "file.txt");
			assertEquals(_log.length, 0);
		},
		// only: true,
	},
]);
