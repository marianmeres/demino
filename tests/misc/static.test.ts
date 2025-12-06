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
]);
