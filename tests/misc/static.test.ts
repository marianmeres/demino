import { assert, assertEquals, assertMatch } from "@std/assert";
import { basename, join } from "@std/path";
import { serveStatic, type ServeStaticOptions } from "../../src/mod.ts";
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
	//
	// ---- end-to-end through the server (what the matrix below pins on the module) ----
	//
	{
		name: "static: per-request headers function sets Cache-Control by path",
		fn: async ({ base, app }) => {
			app.static("/", fsRoot, {
				headers: (req) => ({
					"cache-control": new URL(req.url).pathname.startsWith("/assets/")
						? "public, max-age=31536000, immutable"
						: "no-cache",
				}),
			});

			const asset = await assertResp(fetch(`${base}/assets/x.js`), 200, /console/, {
				"cache-control": "public, max-age=31536000, immutable",
				"content-type": "text/javascript; charset=utf-8",
			});
			const index = await assertResp(fetch(`${base}/index.html`), 200, /index/, {
				"cache-control": "no-cache",
				"content-type": "text/html; charset=utf-8",
			});
			assert(
				asset.headers.get("cache-control") !== index.headers.get("cache-control"),
			);
			// the directory index gets the same per-request policy
			await assertResp(fetch(`${base}/`), 200, /index/, {
				"cache-control": "no-cache",
			});
		},
	},
	{
		name: "static: 301s carry a relative Location through the server",
		fn: async ({ base, app }) => {
			app.static("/files", fsRoot);

			for (
				const [path, location] of [
					["/files", "/files/"],
					["/files//foo.txt", "/files/foo.txt"],
					["/files/foo.txt/?x=1", "/files/foo.txt?x=1"],
				]
			) {
				const res = await fetch(`${base}${path}`, { redirect: "manual" });
				await res.body?.cancel();
				assertEquals(res.status, 301, path);
				assertEquals(res.headers.get("location"), location, path);
			}
		},
	},
	{
		name:
			"static: 405, Range, 304 and the options reach serveStatic through app.static",
		fn: async ({ base, app }) => {
			app.static("/files", fsRoot, { showDotfiles: true, showIndex: false });

			await assertResp(
				fetch(`${base}/files/foo.txt`, { method: "POST" }),
				405,
				/method not allowed/i,
				{ allow: "GET, HEAD" },
			);
			await assertResp(
				fetch(`${base}/files/range.txt`, { headers: { range: "bytes=0-2" } }),
				206,
				"012",
				{ "content-range": "bytes 0-2/10" },
			);
			const get = await assertResp(fetch(`${base}/files/foo.txt`), 200, "foo");
			await assertResp(
				fetch(`${base}/files/foo.txt`, {
					headers: { "if-none-match": get.headers.get("etag")! },
				}),
				304,
				false,
			);
			await assertResp(fetch(`${base}/files/.hidden.txt`), 200, "hidden");
			await assertResp(fetch(`${base}/files/`), 404);
		},
	},
]);

//
// ---- parity matrix: `serveStatic` straight on a `Request`, no server needed ----
//

const fsRoot = join(import.meta.dirname!, "../static");

/** Mounted at `files` unless overridden. */
function call(path: string, init?: RequestInit, opts?: Partial<ServeStaticOptions>) {
	return serveStatic(new Request(`http://localhost${path}`, init), {
		fsRoot,
		urlRoot: "files",
		...opts,
	});
}

/** Reads (and so releases) the body. */
async function drain(p: Promise<Response>): Promise<{ res: Response; text: string }> {
	const res = await p;
	return { res, text: await res.text() };
}

Deno.test("static matrix: non-GET/HEAD → 405 with Allow: GET, HEAD", async () => {
	for (const method of ["POST", "PUT", "DELETE", "OPTIONS", "PATCH"]) {
		const { res, text } = await drain(call("/files/foo.txt", { method }));
		assertEquals(res.status, 405, method);
		assertEquals(res.headers.get("allow"), "GET, HEAD");
		assertEquals(text, "Method Not Allowed");
	}
});

Deno.test("static matrix: /a//b → 301 with a relative Location", async () => {
	for (
		const [path, location] of [
			["/files//foo.txt", "/files/foo.txt"],
			["/files/foo//bar/baz.txt?x=1", "/files/foo/bar/baz.txt?x=1"], // query kept
			["/files/foo///", "/files/foo/"],
			["/files///", "/files/"],
		]
	) {
		const { res, text } = await drain(call(path));
		assertEquals(res.status, 301, path);
		assertEquals(res.headers.get("location"), location, path);
		assert(!res.headers.get("location")!.startsWith("http"), "must be relative");
		assertEquals(text, "");
	}
});

Deno.test("static matrix: file with trailing slash → 301 without it", async () => {
	const { res } = await drain(call("/files/foo.txt/"));
	assertEquals(res.status, 301);
	assertEquals(res.headers.get("location"), "/files/foo.txt");

	const { res: q } = await drain(call("/files/foo/bar/baz.txt/?a=1&b=2"));
	assertEquals(q.status, 301);
	assertEquals(q.headers.get("location"), "/files/foo/bar/baz.txt?a=1&b=2");
});

Deno.test("static matrix: directory without trailing slash → 301 with it", async () => {
	for (
		const [path, location] of [
			["/files", "/files/"],
			["/files/foo", "/files/foo/"],
			["/files/foo?x=1", "/files/foo/?x=1"],
		]
	) {
		const { res } = await drain(call(path));
		assertEquals(res.status, 301, path);
		assertEquals(res.headers.get("location"), location, path);
	}
});

Deno.test("static matrix: traversal → 404 and never reads outside fsRoot", async () => {
	// `tests/_utils.ts` exists one level above `fsRoot` - it must never be served
	for (
		const path of [
			"/files/..%2f..%2fetc/passwd",
			"/files/../x", // the URL parser already resolves this to `/x`
			"/files/..%2f_utils.ts",
			"/files/%2e%2e/_utils.ts",
			"/files/%2e%2e%2f_utils.ts",
			"/files/foo/..%2f..%2f_utils.ts",
			"/files/%5C..%5C..%5C_utils.ts", // encoded backslash
			"/files/foo.txt%00", // NUL
			"/filesX/foo.txt", // prefix must be a whole segment
			"/other/foo.txt",
		]
	) {
		const { res, text } = await drain(call(path));
		assertEquals(res.status, 404, path);
		assertEquals(text, "Not Found");
	}

	// Mounted at the root the normalisation redirect fires first; following it
	// must still end inside `fsRoot` (where no `_utils.ts` exists → 404).
	let path = "/..%2f_utils.ts";
	let status = 0;
	for (let i = 0; i < 3; i++) {
		const { res } = await drain(call(path, undefined, { urlRoot: "" }));
		status = res.status;
		assert(status !== 200, `must not serve ${path}`);
		if (status !== 301) break;
		path = res.headers.get("location")!;
		assert(path.startsWith("/"), "relative Location");
	}
	assertEquals(status, 404);
});

Deno.test("static matrix: dotfile → 404, 200 with showDotfiles", async () => {
	const { res } = await drain(call("/files/.hidden.txt"));
	assertEquals(res.status, 404);

	const { res: ok, text } = await drain(
		call("/files/.hidden.txt", undefined, { showDotfiles: true }),
	);
	assertEquals(ok.status, 200);
	assertEquals(text, "hidden");
});

Deno.test("static matrix: index.html on a directory, showIndex: false → 404", async () => {
	const { res, text } = await drain(call("/files/"));
	assertEquals(res.status, 200);
	assertMatch(text, /index/);
	assertEquals(res.headers.get("content-type"), "text/html; charset=utf-8");

	const { res: off } = await drain(call("/files/", undefined, { showIndex: false }));
	assertEquals(off.status, 404);

	// directory without an index.html
	const { res: noIndex } = await drain(call("/files/foo/"));
	assertEquals(noIndex.status, 404);
});

Deno.test("static matrix: If-None-Match → 304 without body (weak comparison)", async () => {
	const { res: first } = await drain(call("/files/foo.txt"));
	const etag = first.headers.get("etag")!;
	assertMatch(etag, /^W\/"[0-9a-f]+-[0-9a-f]+"$/);

	for (const value of [etag, etag.slice(2), `"nope", ${etag}`, "*"]) {
		const { res, text } = await drain(
			call("/files/foo.txt", { headers: { "if-none-match": value } }),
		);
		assertEquals(res.status, 304, value);
		assertEquals(text, "");
		assertEquals(res.headers.get("etag"), etag);
		assert(res.headers.has("last-modified"));
	}

	const { res: miss, text } = await drain(
		call("/files/foo.txt", { headers: { "if-none-match": '"nope"' } }),
	);
	assertEquals(miss.status, 200);
	assertEquals(text, "foo");

	// HEAD honours it too
	const { res: head } = await drain(
		call("/files/foo.txt", { method: "HEAD", headers: { "if-none-match": etag } }),
	);
	assertEquals(head.status, 304);
});

Deno.test("static matrix: If-Modified-Since → 304", async () => {
	const { res: first } = await drain(call("/files/foo.txt"));
	const lastModified = first.headers.get("last-modified")!;
	assert(!Number.isNaN(Date.parse(lastModified)));

	const { res, text } = await drain(
		call("/files/foo.txt", { headers: { "if-modified-since": lastModified } }),
	);
	assertEquals(res.status, 304);
	assertEquals(text, "");

	const { res: old } = await drain(
		call("/files/foo.txt", {
			headers: { "if-modified-since": "Thu, 01 Jan 1970 00:00:00 GMT" },
		}),
	);
	assertEquals(old.status, 200);

	const { res: garbage } = await drain(
		call("/files/foo.txt", { headers: { "if-modified-since": "not a date" } }),
	);
	assertEquals(garbage.status, 200);

	// If-None-Match present → If-Modified-Since is ignored
	const { res: both } = await drain(
		call("/files/foo.txt", {
			headers: { "if-none-match": '"nope"', "if-modified-since": lastModified },
		}),
	);
	assertEquals(both.status, 200);
});

Deno.test("static matrix: Range: bytes=0-2 → 206 + Content-Range + body slice", async () => {
	for (
		const [range, contentRange, body] of [
			["bytes=0-2", "bytes 0-2/10", "012"],
			["bytes=-3", "bytes 7-9/10", "789"],
			["bytes=8-", "bytes 8-9/10", "89"],
			["bytes=0-99", "bytes 0-9/10", "0123456789"], // end clamped
			["bytes=-99", "bytes 0-9/10", "0123456789"], // start clamped
		]
	) {
		const { res, text } = await drain(
			call("/files/range.txt", { headers: { range } }),
		);
		assertEquals(res.status, 206, range);
		assertEquals(res.headers.get("content-range"), contentRange, range);
		assertEquals(res.headers.get("content-length"), `${body.length}`, range);
		assertEquals(res.headers.get("accept-ranges"), "bytes");
		assertEquals(text, body, range);
	}
});

Deno.test("static matrix: unsatisfiable Range → 416 + bytes */N", async () => {
	for (const range of ["bytes=5-2", "bytes=10-", "bytes=99-100"]) {
		const { res, text } = await drain(
			call("/files/range.txt", { headers: { range } }),
		);
		assertEquals(res.status, 416, range);
		assertEquals(res.headers.get("content-range"), "bytes */10", range);
		assertEquals(text, "Range Not Satisfiable");
	}
});

Deno.test("static matrix: Range on an empty file → 200", async () => {
	const { res, text } = await drain(
		call("/files/empty.txt", { headers: { range: "bytes=0-2" } }),
	);
	assertEquals(res.status, 200);
	assertEquals(res.headers.get("content-length"), "0");
	assertEquals(res.headers.get("content-range"), null);
	assertEquals(text, "");
});

Deno.test("static matrix: unparsable Range → 200 with the whole file", async () => {
	for (const range of ["bytes=abc", "items=0-2", "bytes=1-2,4-5"]) {
		const { res, text } = await drain(
			call("/files/range.txt", { headers: { range } }),
		);
		assertEquals(res.status, 200, range);
		assertEquals(res.headers.get("content-range"), null);
		assertEquals(text, "0123456789");
	}
});

Deno.test("static matrix: HEAD → GET's headers, no body", async () => {
	const { res: get } = await drain(call("/files/foo.txt"));
	const head = await call("/files/foo.txt", { method: "HEAD" });
	assertEquals(head.status, 200);
	assertEquals(head.body, null);
	for (
		const h of [
			"etag",
			"last-modified",
			"content-type",
			"content-length",
			"accept-ranges",
		]
	) {
		assertEquals(head.headers.get(h), get.headers.get(h), h);
	}
	assertEquals(head.headers.get("content-length"), "3");

	// a Range on HEAD does not turn it into a 206
	const ranged = await call("/files/range.txt", {
		method: "HEAD",
		headers: { range: "bytes=0-2" },
	});
	assertEquals(ranged.status, 200);
	assertEquals(ranged.headers.get("content-length"), "10");
	assertEquals(ranged.body, null);
});

Deno.test("static matrix: Content-Type by extension, charset on text-like types", async () => {
	for (
		const [path, type] of [
			["/files/foo.txt", "text/plain; charset=utf-8"],
			["/files/index.html", "text/html; charset=utf-8"],
			["/files/assets/x.js", "text/javascript; charset=utf-8"],
			["/files/noext", "application/octet-stream"],
		]
	) {
		const { res } = await drain(call(path));
		assertEquals(res.status, 200, path);
		assertEquals(res.headers.get("content-type"), type, path);
	}
});

Deno.test("static matrix: headers option (object + function) on 200/206/304, not on 301/404/416", async () => {
	const headers = { "cache-control": "max-age=1", "x-static": "yes" };

	const { res: ok } = await drain(call("/files/foo.txt", undefined, { headers }));
	assertEquals(ok.status, 200);
	assertEquals(ok.headers.get("cache-control"), "max-age=1");
	assertEquals(ok.headers.get("x-static"), "yes");

	const { res: partial } = await drain(
		call("/files/range.txt", { headers: { range: "bytes=0-1" } }, { headers }),
	);
	assertEquals(partial.status, 206);
	assertEquals(partial.headers.get("x-static"), "yes");

	const { res: notModified } = await drain(
		call("/files/foo.txt", { headers: { "if-none-match": "*" } }, { headers }),
	);
	assertEquals(notModified.status, 304);
	assertEquals(notModified.headers.get("x-static"), "yes");

	for (const [path, status] of [["/files", 301], ["/files/nope", 404]] as const) {
		const { res } = await drain(call(path, undefined, { headers }));
		assertEquals(res.status, status, path);
		assertEquals(res.headers.get("x-static"), null, path);
		assertEquals(res.headers.get("cache-control"), null, path);
	}
	const { res: unsat } = await drain(
		call("/files/range.txt", { headers: { range: "bytes=5-2" } }, { headers }),
	);
	assertEquals(unsat.status, 416);
	assertEquals(unsat.headers.get("x-static"), null);

	// function form sees the request and the resolved file path; `set` overrides
	const fn = (req: Request, filePath: string) => ({
		"x-file": basename(filePath),
		"x-method": req.method,
		"content-type": "application/x-custom",
	});
	const { res: file } = await drain(call("/files/foo.txt", undefined, { headers: fn }));
	assertEquals(file.headers.get("x-file"), "foo.txt");
	assertEquals(file.headers.get("x-method"), "GET");
	assertEquals(file.headers.get("content-type"), "application/x-custom");
	const { res: index } = await drain(call("/files/", undefined, { headers: fn }));
	assertEquals(index.headers.get("x-file"), "index.html");

	// returning nothing adds nothing
	const { res: none } = await drain(
		call("/files/foo.txt", undefined, { headers: () => undefined }),
	);
	assertEquals(none.status, 200);
});

Deno.test("static matrix: bad percent-encoding → 400", async () => {
	for (const path of ["/files/%E0%A4%A", "/files/%", "/files/foo%2"]) {
		const { res, text } = await drain(call(path));
		assertEquals(res.status, 400, path);
		assertEquals(text, "Bad Request");
	}
});

Deno.test("static matrix: etag: false → no validators, conditionals ignored", async () => {
	const { res, text } = await drain(
		call("/files/foo.txt", { headers: { "if-none-match": "*" } }, { etag: false }),
	);
	assertEquals(res.status, 200);
	assertEquals(text, "foo");
	assertEquals(res.headers.get("etag"), null);
	assertEquals(res.headers.get("last-modified"), null);
	assertEquals(res.headers.get("content-type"), "text/plain; charset=utf-8");
});

Deno.test("static matrix: urlRoot - absent maps the whole pathname, slashes tolerated", async () => {
	const { res: root, text } = await drain(
		call("/foo.txt", undefined, { urlRoot: undefined }),
	);
	assertEquals(root.status, 200);
	assertEquals(text, "foo");

	const { res: nested } = await drain(
		call("/api/files/foo.txt", undefined, { urlRoot: "api/files" }),
	);
	assertEquals(nested.status, 200);

	const { res: slashed } = await drain(
		call("/files/foo.txt", undefined, { urlRoot: "/files/" }),
	);
	assertEquals(slashed.status, 200);

	const { res: outside } = await drain(
		call("/foo.txt", undefined, { urlRoot: "files" }),
	);
	assertEquals(outside.status, 404);
});
