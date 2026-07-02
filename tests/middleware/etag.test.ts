import { assertEquals } from "@std/assert";
import { withETag } from "../../src/middleware/etag.ts";
import { runTestServerTests } from "../_utils.ts";

runTestServerTests([
	{
		name:
			"etag: HEAD shares the GET validator (same ETag), and conditional HEAD 304s",
		fn: async ({ app, base }) => {
			app.get("/d", withETag(() => ({ hello: "world" })));

			const g = await fetch(`${base}/d`);
			await g.text();
			const gEtag = g.headers.get("etag");
			assertEquals(typeof gEtag, "string");

			const h = await fetch(`${base}/d`, { method: "HEAD" });
			await h.text();
			// HEAD must return the SAME ETag as GET (not the empty-body hash)
			assertEquals(h.headers.get("etag"), gEtag);

			// a conditional HEAD carrying the GET validator must 304
			const cond = await fetch(`${base}/d`, {
				method: "HEAD",
				headers: { "if-none-match": gEtag! },
			});
			await cond.text();
			assertEquals(cond.status, 304);
		},
	},
	{
		name: "etag: 304 carries Vary (and Cache-Control) forward",
		fn: async ({ app, base }) => {
			app.get(
				"/v",
				withETag((_r, _i, ctx) => {
					ctx.headers.set("Vary", "Accept-Encoding");
					ctx.headers.set("Cache-Control", "max-age=60");
					return "body";
				}),
			);

			const g = await fetch(`${base}/v`);
			await g.text();
			const etag = g.headers.get("etag")!;

			const c = await fetch(`${base}/v`, { headers: { "if-none-match": etag } });
			await c.text();
			assertEquals(c.status, 304);
			// Vary must survive onto the 304 (else a shared cache can serve the wrong
			// negotiated variant); Cache-Control too.
			assertEquals(c.headers.get("vary"), "Accept-Encoding");
			assertEquals(c.headers.get("cache-control"), "max-age=60");
		},
	},
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
		name: "etag skips bodies larger than maxSizeBytes",
		fn: async ({ app, base }) => {
			const big = "x".repeat(2048);
			app.get("/big", withETag(() => big, { maxSizeBytes: 1024 }));

			const res = await fetch(`${base}/big`);
			const body = await res.text();
			assertEquals(res.status, 200);
			assertEquals(res.headers.has("etag"), false);
			assertEquals(body, big);
		},
	},
	{
		name: "etag respects Content-Length to skip large responses early",
		fn: async ({ app, base }) => {
			app.get(
				"/big-cl",
				withETag(
					() => {
						return new Response("x".repeat(2048), {
							headers: { "content-length": "2048" },
						});
					},
					{ maxSizeBytes: 1024 },
				),
			);

			const res = await fetch(`${base}/big-cl`);
			await res.text();
			assertEquals(res.status, 200);
			assertEquals(res.headers.has("etag"), false);
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
