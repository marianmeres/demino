import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { assertResp, runTestServerTests } from "../_utils.ts";

runTestServerTests([
	{
		name: "serve static on route",
		fn: async ({ base, app }) => {
			app.static("/", join(import.meta.dirname!, "../static"));
			app.get("/hello", () => "world");

			await assertResp(fetch(`${base}`), 200, /index/); // showIndex is true by default
			await assertResp(fetch(`${base}/foo.txt`), 200, /foo/);
			await assertResp(fetch(`${base}/foo`), 404);
			await assertResp(fetch(`${base}/foo/bar/baz.txt`), 200, /baz/);
			await assertResp(fetch(`${base}/hey/ho`), 404);
			await assertResp(fetch(`${base}/hello`), 200, /world/);
		},
	},
	{
		name: "serve static on route",
		fn: async ({ base, app }) => {
			app.get("/", () => "hello");
			app.static("/files", join(import.meta.dirname!, "../static"));

			await assertResp(fetch(`${base}`), 200, /hello/);
			await assertResp(fetch(`${base}/files`), 200, /index/); // showIndex is true by default
			await assertResp(fetch(`${base}/files/foo.txt`), 200, /foo/);
			await assertResp(fetch(`${base}/files/foo`), 404);
			await assertResp(fetch(`${base}/files/foo/bar/baz.txt`), 200, /baz/);
			await assertResp(fetch(`${base}/files/hey/ho`), 404);
		},
	},
	{
		name: "serve static on inner route",
		fn: async ({ base, app }) => {
			app.get("/", () => "hello");
			app.static("/m/y/fil/es", join(import.meta.dirname!, "../static"));

			await assertResp(fetch(`${base}`), 200, /hello/);
			await assertResp(fetch(`${base}/m/y/fil/es`), 200, /index/); // showIndex is true by default
			await assertResp(fetch(`${base}/m/y/fil/es/foo`), 404);
			await assertResp(fetch(`${base}/m/y/fil/es/foo/bar/baz.txt`), 200, /baz/);
			await assertResp(fetch(`${base}/m/y/fil/es/hey/ho`), 404);
		},
	},
	{
		// Regression: serveDir handles HEAD natively (no manual GET-rewrite).
		// Expect the same status + headers as GET, but an empty body.
		name: "HEAD on static file returns headers without body",
		fn: async ({ base, app }) => {
			app.static("/files", join(import.meta.dirname!, "../static"));

			const get = await fetch(`${base}/files/foo.txt`);
			const getBody = await get.text();
			assertEquals(get.status, 200);
			assert(getBody.length > 0, "GET should have a body");

			const head = await fetch(`${base}/files/foo.txt`, { method: "HEAD" });
			const headBody = await head.text();
			assertEquals(head.status, 200);
			assertEquals(headBody.length, 0, "HEAD response must have no body");
			// Deno's fetch strips Content-Length from HEAD responses, but ETag
			// is preserved — and matching ETags prove serveDir served HEAD
			// natively rather than returning a 404 or rewriting the request.
			assertEquals(
				head.headers.get("etag"),
				get.headers.get("etag"),
				"HEAD and GET must share ETag",
			);
		},
	},
]);
