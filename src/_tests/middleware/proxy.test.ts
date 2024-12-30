// deno-lint-ignore-file no-explicit-any

import { sleep } from "@marianmeres/midware";
import { serveFile } from "@std/http/file-server";
import { proxy } from "../../middleware/proxy.ts";
import {
	assertResp,
	runTestServerTests,
	type TestServerTestsParams,
} from "../_utils.ts";

runTestServerTests([
	{
		name: "proxy works",
		fn: async ({ srv, app }: TestServerTestsParams) => {
			const { base } = srv;

			app.get("/a", () => "a");
			app.get("/b", (r) => new URL(r.url).search);
			app.get("/c", proxy("/d"));
			app.get("/d", () => "d");
			app.get("/file", (req) => serveFile(req, "./src/_tests/static/foo.txt"));

			app.get("/to-self", proxy("/to-self")); // will throw

			app.get("/xa", proxy("/a"));
			app.get("/xb", proxy("/b"));
			app.get("/xc", proxy("/c"));
			app.get("/xfile", proxy("/file"));

			await assertResp(fetch(`${base}/xa`), 200, "a");
			await assertResp(fetch(`${base}/xb?foo=bar`), 200, "?foo=bar");
			await assertResp(fetch(`${base}/xc`), 200, "d"); // not c!
			await assertResp(fetch(`${base}/to-self`), 500, /proxy to self/i);
			await assertResp(fetch(`${base}/xfile`), 200, "foo");

			//
			const _sleepTimer = { id: -1 };
			app.get("/slow", async () => {
				await sleep(100, _sleepTimer);
				return "woke up";
			});
			app.get("/xslow", proxy("/slow", { timeout: 20 }));
			await assertResp(fetch(`${base}/xslow`), 500, /timed out/i);
			clearTimeout(_sleepTimer.id);

			// target as full url
			app.get("/full", proxy(`${base}/d`));
			await assertResp(fetch(`${base}/full`), 200, "d");

			// relative target
			app.get("/a/b", () => "/a/b");
			app.get("/a/b/c/d", proxy("../"));
			await assertResp(fetch(`${base}/a/b/c/d`), 200, "/a/b");

			// wildcard proxy
			app.get(
				"/old/*",
				proxy((r) => {
					const path = new URL(r.url).pathname.slice("/old".length);
					return `/new${path}`;
				})
			);
			app.get("/new/*", (r) => new URL(r.url).pathname);

			await assertResp(fetch(`${base}/old`), 200, "/new");
			await assertResp(fetch(`${base}/old/`), 200, "/new/");
			await assertResp(fetch(`${base}/old/x/y/z`), 200, "/new/x/y/z");
		},
	},
]);
