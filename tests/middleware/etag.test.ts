import { assertEquals } from "@std/assert";
import { withETag } from "../../src/middleware/etag.ts";
import { runTestServerTests } from "../_utils.ts";

runTestServerTests([
	{
		name: "etag generates ETag and handles 304",
		fn: async ({ app, base }) => {
			app.get(
				"/data",
				withETag(() => ({ message: "hello world" })),
			);

			// First request - should get 200 with ETag
			const res1 = await fetch(`${base}/data`);
			assertEquals(res1.status, 200);
			const etag = res1.headers.get("etag");
			assertEquals(typeof etag, "string");
			assertEquals(etag?.startsWith('"'), true); // Strong ETag
			assertEquals(etag?.endsWith('"'), true);
			const body1 = await res1.json();
			assertEquals(body1, { message: "hello world" });

			// Second request with If-None-Match - should get 304
			const res2 = await fetch(`${base}/data`, {
				headers: { "If-None-Match": etag! },
			});
			assertEquals(res2.status, 304);
			assertEquals(res2.headers.get("etag"), etag);
			const body2 = await res2.text();
			assertEquals(body2, ""); // Empty body for 304
		},
	},
	{
		name: "etag supports weak ETags",
		fn: async ({ app, base }) => {
			app.get(
				"/data",
				withETag(() => "test data", { weak: true }),
			);

			const res = await fetch(`${base}/data`);
			await res.text(); // Consume body
			assertEquals(res.status, 200);
			const etag = res.headers.get("etag");
			assertEquals(etag?.startsWith('W/"'), true); // Weak ETag
		},
	},
	{
		name: "etag only works on GET/HEAD",
		fn: async ({ app, base }) => {
			app.post(
				"/data",
				withETag(() => ({ message: "created" })),
			);

			const res = await fetch(`${base}/data`, {
				method: "POST",
			});
			await res.text(); // Consume body
			assertEquals(res.status, 200);
			assertEquals(res.headers.has("etag"), false); // No ETag for POST
		},
	},
	{
		name: "etag preserves existing ETag",
		fn: async ({ app, base }) => {
			app.get(
				"/data",
				withETag(() => {
					return new Response("data", {
						headers: { etag: '"custom-etag"' },
					});
				}),
			);

			const res = await fetch(`${base}/data`);
			await res.text(); // Consume body
			assertEquals(res.status, 200);
			assertEquals(res.headers.get("etag"), '"custom-etag"'); // Preserves custom
		},
	},
	{
		name: "etag handles multiple ETags in If-None-Match",
		fn: async ({ app, base }) => {
			app.get(
				"/data",
				withETag(() => "hello"),
			);

			// Get the actual ETag
			const res1 = await fetch(`${base}/data`);
			await res1.text(); // Consume body
			const etag = res1.headers.get("etag")!;

			// Request with multiple ETags
			const res2 = await fetch(`${base}/data`, {
				headers: {
					"If-None-Match": `"wrong-etag", ${etag}, "another-wrong"`,
				},
			});
			await res2.text(); // Consume body (will be empty for 304)
			assertEquals(res2.status, 304); // Should match
		},
	},
]);
