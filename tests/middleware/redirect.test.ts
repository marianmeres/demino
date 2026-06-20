import { redirect } from "../../src/middleware/redirect.ts";
import { assertResp, runTestServerTests } from "../_utils.ts";

runTestServerTests([
	{
		name: "proxy works",
		fn: async ({ app, base }) => {
			app.use("/old", redirect("/new"));

			app.get("/old", () => "old");
			app.get("/new", () => "new");

			await assertResp(fetch(`${base}/old`), 200, "new");
		},
	},
	{
		// Part 1 (the bug fix): a same-origin redirect must emit a RELATIVE
		// `Location` so it never carries the proxy->app hop's `http://` scheme.
		name: "redirect emits a relative Location for same-origin target",
		fn: async ({ app, base }) => {
			app.get("/old", redirect("/new", 302));
			await assertResp(fetch(`${base}/old`, { redirect: "manual" }), 302, "", {
				// relative, NOT http(s)://...
				location: /^\/new$/,
			});
		},
	},
	{
		name: "redirect preserves query and hash for same-origin target",
		fn: async ({ app, base }) => {
			app.get("/old", redirect("/new?x=1#frag", 301));
			await assertResp(fetch(`${base}/old`, { redirect: "manual" }), 301, "", {
				location: /^\/new\?x=1#frag$/,
			});
		},
	},
	{
		// `redirect("https://...")` (cross-origin) must stay ABSOLUTE & unchanged.
		name: "redirect keeps an absolute external target unchanged",
		fn: async ({ app, base }) => {
			app.get("/ext", redirect("https://example.com/foo?a=b", 302));
			await assertResp(fetch(`${base}/ext`, { redirect: "manual" }), 302, "", {
				location: /^https:\/\/example\.com\/foo\?a=b$/,
			});
		},
	},
	{
		// A relative (non-anchored) target still normalizes against the request URL.
		name: "redirect normalizes a relative target against the request URL",
		fn: async ({ app, base }) => {
			app.get("/a/b", redirect("c"));
			await assertResp(fetch(`${base}/a/b`, { redirect: "manual" }), 302, "", {
				location: /^\/a\/c$/,
			});
		},
	},
]);
