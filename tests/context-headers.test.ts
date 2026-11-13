import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createHttpError } from "@marianmeres/http-utils";
import { createResponseFrom, type DeminoContext, demino } from "../src/demino.ts";
import { type CookiesLocals, cookies } from "../src/middleware/cookies.ts";
import { cors } from "../src/middleware/cors.ts";
import { withETag } from "../src/middleware/etag.ts";
import { proxy } from "../src/middleware/proxy/proxy.ts";
import { rateLimit } from "../src/middleware/rate-limit.ts";
import { redirect } from "../src/middleware/redirect.ts";
import { header, startTestServer } from "./_utils.ts";

// `ctx.headers` reach every response, also a `Response` instance a handler or a custom
// error handler returned (since 2.1.0; before, only the responses Demino built itself).
// The returned response's own headers win; `set-cookie` and `vary` are merged.

const fsRoot = fileURLToPath(new URL("./static", import.meta.url));

const request = (path: string, init?: RequestInit) =>
	new Request(`http://localhost${path}`, init);

/** `ctx.locals` as the cookies() middleware leaves it. */
const cookieJar = (ctx: DeminoContext) => ctx.locals as unknown as CookiesLocals;

test("context headers: reach a Response the handler returned, its own headers win", async () => {
	const app = demino().logger(null);
	app.use((_req, _info, ctx) => {
		ctx.headers.set("x-from-ctx", "1");
		ctx.headers.set("cache-control", "no-store");
	});
	const own = new Response("raw", { headers: { "cache-control": "max-age=60" } });
	app.get("/", () => own);
	app.get("/status", (_req, _info, ctx) => {
		ctx.status = 201;
		return new Response("raw");
	});

	let r = await app(request("/"));
	assert.equal(await r.text(), "raw");
	assert.equal(r.headers.get("x-from-ctx"), "1");
	assert.equal(r.headers.get("cache-control"), "max-age=60");
	// a response with a body is the handler's own object, not a copy
	assert.equal(r, own);

	// the status stays the Response's own
	r = await app(request("/status"));
	assert.equal(r.status, 200);
});

test("context headers: cors() covers app.static() and proxy()", async () => {
	const upstream = demino().logger(null);
	upstream.get("/data", () => new Response("up", { headers: { vary: "Accept" } }));
	const up = await startTestServer(upstream);

	const app = demino().logger(null);
	app.use(cors({ allowOrigin: ["https://app.example"] }));
	app.static("/files", fsRoot);
	app.get("/proxied", proxy(`${up.base}/data`));

	const srv = await startTestServer(app);
	try {
		const origin = { origin: "https://app.example" };

		let r = await fetch(`${srv.base}/files/foo.txt`, { headers: origin });
		const body = await r.text();
		assert.equal(body, "foo");
		assert.equal(r.headers.get("access-control-allow-origin"), "https://app.example");
		assert.equal(r.headers.get("vary"), "Origin");
		// the file response is otherwise as serveStatic() built it
		assert.equal(r.headers.get("content-length"), String(body.length));
		assert.match(header(r, "content-type"), /^text\/plain/);

		// a proxied response: its headers are immutable until rebuilt, its Vary is kept
		r = await fetch(`${srv.base}/proxied`, { headers: origin });
		assert.equal(await r.text(), "up");
		assert.equal(r.headers.get("access-control-allow-origin"), "https://app.example");
		assert.equal(r.headers.get("vary"), "Accept, Origin");

		// another origin gets no allow header, on either
		r = await fetch(`${srv.base}/files/foo.txt`, {
			headers: { origin: "https://evil.example" },
		});
		await r.text();
		assert.equal(r.headers.has("access-control-allow-origin"), false);
		assert.equal(r.headers.get("vary"), "Origin");
	} finally {
		await srv.close();
		await up.close();
	}
});

test("context headers: cookies set before a redirect() survive it", async () => {
	const app = demino().logger(null);
	app.use(cookies({ path: "/" }));
	app.get("/login", (req, info, ctx) => {
		cookieJar(ctx).setCookie("session", "abc");
		cookieJar(ctx).setCookie("theme", "dark");
		return redirect("/home", 303)(req, info, ctx);
	});

	const r = await app(request("/login"));
	assert.equal(r.status, 303);
	assert.equal(r.headers.get("location"), "/home");
	assert.deepEqual(r.headers.getSetCookie(), [
		"session=abc; Path=/",
		"theme=dark; Path=/",
	]);
});

test("context headers: reach a custom error handler's Response (Retry-After, Allow)", async () => {
	const app = demino().logger(null);
	app.error(
		(_req, _info, ctx) =>
			new Response("refused", { status: ctx.error?.status ?? 500 }),
	);
	app.get(
		"/limited",
		rateLimit(() => "one-client", { maxSize: 1, refillSizePerSecond: 1 }),
		() => "ok",
	);

	assert.equal((await app(request("/limited"))).status, 200);
	let r = await app(request("/limited"));
	assert.equal(r.status, 429);
	assert.equal(await r.text(), "refused");
	assert.match(header(r, "retry-after"), /^[1-9][0-9]*$/);

	// the 405 the app itself generates keeps its mandatory Allow
	r = await app(request("/limited", { method: "POST" }));
	assert.equal(r.status, 405);
	assert.equal(r.headers.get("allow"), "GET, HEAD");
});

test("context headers: a content-type fills in on a returned Response, but not on the error path", async () => {
	const app = demino().logger(null);
	app.error((_req, _info, ctx) => new Response(null, { status: ctx.error?.status }));
	app.use((_req, _info, ctx) => {
		ctx.headers.set("content-type", "text/csv");
	});
	app.get("/bytes", () => new Response(new TextEncoder().encode("a,b")));
	app.get(
		"/own",
		() => new Response("<p>hi</p>", { headers: { "content-type": "text/html" } }),
	);
	app.get("/throws", () => {
		throw createHttpError(409);
	});

	// the response named none: the one set on the context applies
	let r = await app(request("/bytes"));
	assert.equal(r.headers.get("content-type"), "text/csv");

	r = await app(request("/own"));
	assert.equal(r.headers.get("content-type"), "text/html");

	// it described the body the handler planned, not the error's
	r = await app(request("/throws"));
	assert.equal(r.status, 409);
	assert.equal(r.headers.has("content-type"), false);
});

test("context headers: Vary is merged by token", async () => {
	const app = demino().logger(null);
	app.use((_req, _info, ctx) => {
		ctx.headers.set("vary", "Origin, Accept-Encoding");
	});
	app.get("/none", () => new Response("x"));
	app.get("/some", () => new Response("x", { headers: { vary: "accept-encoding" } }));
	app.get(
		"/all",
		() => new Response("x", { headers: { vary: "Accept-Encoding, origin" } }),
	);
	app.get("/star", () => new Response("x", { headers: { vary: "*" } }));

	assert.equal(
		(await app(request("/none"))).headers.get("vary"),
		"Origin, Accept-Encoding",
	);
	assert.equal(
		(await app(request("/some"))).headers.get("vary"),
		"accept-encoding, Origin",
	);
	assert.equal(
		(await app(request("/all"))).headers.get("vary"),
		"Accept-Encoding, origin",
	);
	assert.equal((await app(request("/star"))).headers.get("vary"), "*");
});

test("context headers: nothing is doubled on a Response already built from ctx.headers", async () => {
	const app = demino().logger(null);
	app.use(cookies());
	// a wrapper that builds the Response itself, the way createResponseFrom() documents
	app.get("/wrapped", (req, _info, ctx) => {
		cookieJar(ctx).setCookie("a", "1");
		ctx.headers.set("vary", "Origin");
		return createResponseFrom(req, { ok: true }, ctx.headers, ctx.status);
	});
	// withETag() does the same internally
	app.get(
		"/etag",
		withETag((_req, _info, ctx) => {
			cookieJar(ctx).setCookie("b", "2");
			return { ok: true };
		}),
	);

	let r = await app(request("/wrapped"));
	assert.deepEqual(await r.json(), { ok: true });
	assert.deepEqual(r.headers.getSetCookie(), ["a=1"]);
	assert.equal(r.headers.get("vary"), "Origin");

	r = await app(request("/etag"));
	assert.deepEqual(r.headers.getSetCookie(), ["b=2"]);
	const etag = header(r, "etag");

	// the 304 carries the cookie too (it is not among the headers withETag() copies)
	r = await app(request("/etag", { headers: { "if-none-match": etag } }));
	assert.equal(r.status, 304);
	assert.deepEqual(r.headers.getSetCookie(), ["b=2"]);
});

test("context headers: a shared bodiless Response is copied, never written to", async () => {
	// such an instance can be returned for every request, so nothing of one request
	// (its cookie!) may stay on it for the next
	const shared = new Response(null, { status: 204 });
	const app = demino().logger(null);
	app.use(cookies());
	app.get("/", (req, _info, ctx) => {
		cookieJar(ctx).setCookie("user", new URL(req.url).searchParams.get("u") ?? "");
		return shared;
	});

	const alice = await app(request("/?u=alice"));
	const bob = await app(request("/?u=bob"));

	assert.equal(alice.status, 204);
	assert.deepEqual(alice.headers.getSetCookie(), ["user=alice"]);
	assert.deepEqual(bob.headers.getSetCookie(), ["user=bob"]);
	assert.notEqual(alice, shared);
	assert.deepEqual([...shared.headers.keys()], []);
});

test("context headers: a Response with immutable headers gets them too", async () => {
	const app = demino().logger(null);
	app.use((_req, _info, ctx) => {
		ctx.headers.set("x-from-ctx", "1");
	});
	app.get("/moved", () => Response.redirect("http://example.com/there", 302));

	const r = await app(request("/moved"));
	assert.equal(r.status, 302);
	assert.equal(r.headers.get("location"), "http://example.com/there");
	assert.equal(r.headers.get("x-from-ctx"), "1");
});

test("context headers: X-Powered-By and X-Response-Time are on every response", async () => {
	const app = demino().logger(null);
	app.get("/built", () => "built");
	app.get("/returned", () => new Response("returned"));
	app.get("/own", () => new Response("own", { headers: { "x-powered-by": "Other" } }));
	app.get("/old", redirect("/new"));
	app.static("/files", fsRoot);

	for (const path of ["/built", "/returned", "/old", "/files/foo.txt", "/nope"]) {
		const r = await app(request(path));
		assert.equal(r.headers.get("x-powered-by"), "Demino", path);
		assert.match(header(r, "x-response-time"), /^\d+ms$/, path);
	}

	// a response that carries one already keeps it
	const own = await app(request("/own"));
	assert.equal(own.headers.get("x-powered-by"), "Other");

	// a custom error handler's Response gets them as well
	app.error((_req, _info, ctx) => new Response("oops", { status: ctx.error?.status }));
	const custom = await app(request("/nope"));
	assert.equal(custom.status, 404);
	assert.equal(custom.headers.get("x-powered-by"), "Demino");

	// and the two options still turn them off, everywhere
	const quiet = demino("", [], {
		logger: null,
		noXPoweredBy: true,
		noXResponseTime: true,
	});
	quiet.get("/built", () => "built");
	quiet.get("/returned", () => new Response("returned"));
	for (const path of ["/built", "/returned", "/nope"]) {
		const r = await quiet(request(path));
		assert.equal(r.headers.has("x-powered-by"), false, path);
		assert.equal(r.headers.has("x-response-time"), false, path);
	}
});

test("context headers: a response hook's replacement is sent as the hook made it", async () => {
	const app = demino("", [], {
		logger: null,
		noXPoweredBy: true,
		noXResponseTime: true,
	});
	app.use((_req, _info, ctx) => {
		ctx.headers.set("x-from-ctx", "1");
	});
	app.get("/fresh", () => "original");
	app.get("/kept", () => "original");
	app.onResponse((req, _info, _ctx, res) => {
		// the response in hand carries the context headers already ...
		assert.equal(res.headers.get("x-from-ctx"), "1");
		return new URL(req.url).pathname === "/fresh"
			? new Response("replaced") // ... a new one starts from nothing
			: new Response("replaced", res); // ... unless it is built from the one in hand
	});

	assert.equal((await app(request("/fresh"))).headers.has("x-from-ctx"), false);
	assert.equal((await app(request("/kept"))).headers.get("x-from-ctx"), "1");
});
