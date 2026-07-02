import { assert } from "@std/assert";
import { assertResp, runTestServerTests } from "./_utils.ts";

// A request whose path is served by *other* methods is a 405 (with the RFC-required
// Allow header), not a 404. Catch-alls never fabricate an Allow set.
runTestServerTests([
	{
		name: "405 + Allow for wrong-method requests (404 only for unknown paths)",
		fn: async ({ app, base }) => {
			app.get("/only-get", () => "g");
			app.post("/only-post", () => "p");

			// POST to a GET-only route -> 405; Allow lists GET and the auto-HEAD
			const r1 = await fetch(`${base}/only-get`, { method: "POST" });
			await r1.text();
			assert(r1.status === 405, `expected 405, got ${r1.status}`);
			const allow1 = r1.headers.get("allow") ?? "";
			assert(/GET/.test(allow1), `Allow missing GET: "${allow1}"`);
			assert(/HEAD/.test(allow1), `Allow missing HEAD: "${allow1}"`);

			// HEAD to a POST-only route -> 405 with Allow: POST (the old HEAD-specific
			// branch, now generalized to every method)
			const r2 = await fetch(`${base}/only-post`, { method: "HEAD" });
			await r2.text();
			assert(r2.status === 405, `expected 405, got ${r2.status}`);
			assert(/POST/.test(r2.headers.get("allow") ?? ""), "Allow missing POST");

			// a genuinely unknown path is still a 404
			await assertResp(fetch(`${base}/nope`, { method: "POST" }), 404);
		},
	},
	{
		name: "a GET catch-all does not fabricate a 405 for other methods",
		fn: async ({ app, base }) => {
			app.get("/real", () => "r");
			app.get("*", () => "catch"); // catch-all also auto-registers HEAD "*"

			// unknown path is served by "*"
			await assertResp(fetch(`${base}/whatever`, { method: "GET" }), 200, "catch");
			// DELETE to a path only served by a catch-all -> 404, NOT 405: catch-alls
			// are excluded from the Allow scan, so they never fabricate a 405.
			const d = await fetch(`${base}/whatever`, { method: "DELETE" });
			await d.text();
			assert(d.status === 404, `expected 404, got ${d.status}`);
		},
	},
]);
