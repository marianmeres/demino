import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createHttpError } from "@marianmeres/http-utils";
import { type DeminoLogger, type DeminoResponseHook, demino } from "../src/demino.ts";
import { proxy } from "../src/middleware/proxy/proxy.ts";
import { redirect } from "../src/middleware/redirect.ts";
import { deminoCompose } from "../src/misc/compose.ts";
import { startTestServer } from "./_utils.ts";

// Response hooks (`app.onResponse`): app-level code that sees every response the app
// returns. Most cases call the app directly - it is a `(req) => Promise<Response>`
// function - and only the ones about what reaches the wire start a server.

const fsRoot = fileURLToPath(new URL("./static", import.meta.url));

const request = (path: string, init?: RequestInit) =>
	new Request(`http://localhost${path}`, init);

/** A hook that tags the response, so a test can tell it ran. */
const tag: DeminoResponseHook = (_req, _info, _ctx, res) => {
	res.headers.set("x-hook", "1");
};

/** Logger that records what the app error-logs and access-logs. */
function recordingLogger() {
	const errors: { status: number; error: string }[] = [];
	const statuses: number[] = [];
	const logger: DeminoLogger = {
		debug() {},
		log() {},
		warn() {},
		error: (e) => errors.push(e),
		access: (d) => statuses.push(d.status),
	};
	return { logger, errors, statuses };
}

test("response hook: runs for every kind of response the app returns", async () => {
	const app = demino().logger(null);
	const seen: Record<string, { status: number; route: string; error: boolean }> = {};
	app.onResponse((req, _info, ctx, res) => {
		seen[`${req.method} ${new URL(req.url).pathname}`] = {
			status: res.status,
			route: ctx.route,
			error: !!ctx.error,
		};
	});
	app.onResponse(tag);

	app.get("/object", () => ({ a: 1 }));
	app.get("/nothing", () => undefined);
	app.get("/response", () => new Response("raw", { headers: { "x-own": "1" } }));
	app.get("/throws", () => {
		throw createHttpError(403);
	});
	app.get("/returns-error", () => new Error("boom"));

	// built from a returned value
	let r = await app(request("/object"));
	assert.equal(r.status, 200);
	assert.deepEqual(await r.json(), { a: 1 });
	assert.equal(r.headers.get("x-hook"), "1");
	assert.match(r.headers.get("content-type") ?? "", /json/);

	r = await app(request("/nothing"));
	assert.equal(r.status, 204);
	assert.equal(r.headers.get("x-hook"), "1");

	// the auto-registered HEAD
	r = await app(request("/object", { method: "HEAD" }));
	assert.equal(r.status, 200);
	assert.equal(await r.text(), "");
	assert.equal(r.headers.get("x-hook"), "1");

	// a Response the handler returned keeps what it had
	r = await app(request("/response"));
	assert.equal(await r.text(), "raw");
	assert.equal(r.headers.get("x-own"), "1");
	assert.equal(r.headers.get("x-hook"), "1");

	// the default error response, thrown and returned
	r = await app(request("/throws"));
	assert.equal(r.status, 403);
	assert.equal(r.headers.get("x-hook"), "1");

	r = await app(request("/returns-error"));
	assert.equal(r.status, 500);
	assert.equal(r.headers.get("x-hook"), "1");

	// the app's own 404, and its 405 with `Allow` intact
	r = await app(request("/nope"));
	assert.equal(r.status, 404);
	assert.equal(r.headers.get("x-hook"), "1");

	r = await app(request("/object", { method: "POST" }));
	assert.equal(r.status, 405);
	assert.equal(r.headers.get("allow"), "GET, HEAD");
	assert.equal(r.headers.get("x-hook"), "1");

	// ctx is the request's own context
	assert.deepEqual(seen, {
		"GET /object": { status: 200, route: "/object", error: false },
		"GET /nothing": { status: 204, route: "/nothing", error: false },
		"HEAD /object": { status: 200, route: "/object", error: false },
		"GET /response": { status: 200, route: "/response", error: false },
		"GET /throws": { status: 403, route: "/throws", error: true },
		"GET /returns-error": { status: 500, route: "/returns-error", error: true },
		"GET /nope": { status: 404, route: "", error: true },
		"POST /object": { status: 405, route: "", error: true },
	});
});

test("response hook: sees a custom error handler's Response", async () => {
	const app = demino().logger(null);
	app.error(
		(_req, _info, ctx) =>
			new Response(JSON.stringify({ title: ctx.error?.message }), {
				status: ctx.error?.status ?? 500,
				headers: { "content-type": "application/problem+json" },
			}),
	);
	app.onResponse(tag);
	app.get("/throws", () => {
		throw createHttpError(401);
	});

	for (const [path, status] of [
		["/throws", 401],
		["/nope", 404],
	] as const) {
		const r = await app(request(path));
		assert.equal(r.status, status);
		assert.equal(r.headers.get("content-type"), "application/problem+json");
		assert.equal(r.headers.get("x-hook"), "1");
	}
});

test("response hook: hooks run in registration order, a returned Response replaces the one in hand", async () => {
	const app = demino().logger(null);
	const order: string[] = [];
	app.onResponse((_req, _info, _ctx, res) => {
		order.push(`a:${res.status}`);
		return new Response("replaced", { status: 202 });
	});
	// anything but a Response keeps the one in hand
	app.onResponse((() => "ignored") as unknown as DeminoResponseHook);
	app.onResponse(async (_req, _info, _ctx, res) => {
		order.push(`b:${res.status}`);
		res.headers.set("x-seen", await res.clone().text());
	});
	app.get("/", () => "original");

	const r = await app(request("/"));
	assert.equal(r.status, 202);
	assert.equal(await r.text(), "replaced");
	assert.equal(r.headers.get("x-seen"), "replaced");
	assert.deepEqual(order, ["a:200", "b:202"]);
});

test("response hook: the `onResponse` option registers hooks, ahead of app.onResponse()", async () => {
	const order: string[] = [];
	const hook =
		(name: string): DeminoResponseHook =>
		() => {
			order.push(name);
		};

	const app = demino("", [], { logger: null, onResponse: [hook("a"), hook("b")] });
	app.onResponse(hook("c")).get("/", () => "ok");
	await app(request("/"));
	assert.deepEqual(order, ["a", "b", "c"]);

	order.length = 0;
	const single = demino("", [], { logger: null, onResponse: hook("solo") });
	single.get("/", () => "ok");
	await single(request("/"));
	assert.deepEqual(order, ["solo"]);
});

test("response hook: registering anything but a function throws at registration", () => {
	const app = demino().logger(null);
	assert.throws(
		() => app.onResponse("nope" as unknown as DeminoResponseHook),
		TypeError,
	);
	assert.throws(
		() => demino("", [], { onResponse: [null as unknown as DeminoResponseHook] }),
		TypeError,
	);
});

test("response hook: a response with mutable headers is handed over as it is, not rebuilt", async () => {
	const own = new Response("own");
	const app = demino().logger(null);
	app.get("/", () => own);

	// no hook: the handler's Response is what the app returns
	assert.equal(await app(request("/")), own);

	let given: Response | undefined;
	app.onResponse((_req, _info, _ctx, res) => {
		given = res;
	});
	assert.equal(await app(request("/")), own);
	assert.equal(given, own);
});

test("response hook: a header set by a hook is on static(), proxy() and redirect() responses", async () => {
	const app = demino().logger(null);
	app.onResponse(tag);
	app.static("/files", fsRoot);
	app.get("/upstream", () => "up");
	app.get("/proxied", proxy("/upstream"));
	app.get("/old", redirect("/new", 301));

	const srv = await startTestServer(app);
	try {
		let r = await fetch(`${srv.base}/files/foo.txt`);
		const body = await r.text();
		assert.equal(r.status, 200);
		assert.match(body, /foo/);
		assert.equal(r.headers.get("x-hook"), "1");
		// the file response went out as serveStatic() built it
		assert.equal(r.headers.get("content-length"), String(body.length));
		assert.ok(r.headers.has("etag"));

		r = await fetch(`${srv.base}/files/missing.txt`);
		await r.text();
		assert.equal(r.status, 404);
		assert.equal(r.headers.get("x-hook"), "1");

		r = await fetch(`${srv.base}/proxied`);
		assert.equal(r.status, 200);
		assert.equal(await r.text(), "up");
		assert.equal(r.headers.get("x-hook"), "1");

		r = await fetch(`${srv.base}/old`, { redirect: "manual" });
		await r.text();
		assert.equal(r.status, 301);
		assert.equal(r.headers.get("location"), "/new");
		assert.equal(r.headers.get("x-hook"), "1");
	} finally {
		await srv.close();
	}
});

test("response hook: can set a header on a response whose headers are immutable", async () => {
	const upstream = demino().logger(null);
	upstream.get("/data", () => ({ from: "upstream" }));
	const up = await startTestServer(upstream);

	const app = demino().logger(null);
	// a fetch() result and a Response.redirect() both carry an immutable header list:
	// `headers.set()` on them is a TypeError
	app.get("/fetched", () => fetch(`${up.base}/data`));
	app.get("/moved", () => Response.redirect("http://example.com/there", 302));
	app.onResponse(tag);

	const srv = await startTestServer(app);
	try {
		let r = await fetch(`${srv.base}/fetched`);
		assert.equal(r.status, 200);
		assert.deepEqual(await r.json(), { from: "upstream" });
		assert.equal(r.headers.get("x-hook"), "1");

		r = await fetch(`${srv.base}/moved`, { redirect: "manual" });
		await r.text();
		assert.equal(r.status, 302);
		assert.equal(r.headers.get("location"), "http://example.com/there");
		assert.equal(r.headers.get("x-hook"), "1");
	} finally {
		await srv.close();
		await up.close();
	}
});

test("response hook: per app - a hook does not run for another app under deminoCompose", async () => {
	const root = demino().logger(null);
	root.get("/", () => "root");
	root.onResponse(tag);

	const other = demino("/other").logger(null);
	other.get("/", () => "other");

	const composed = deminoCompose([root, other]);

	let r = await composed(request("/"));
	assert.equal(await r.text(), "root");
	assert.equal(r.headers.get("x-hook"), "1");

	r = await composed(request("/other"));
	assert.equal(await r.text(), "other");
	assert.equal(r.headers.has("x-hook"), false);

	// the other app's own 404 is its own as well
	r = await composed(request("/other/missing"));
	assert.equal(r.status, 404);
	assert.equal(r.headers.has("x-hook"), false);
});

test("response hook: the access log reports the status after the hooks", async () => {
	const { logger, statuses } = recordingLogger();
	const app = demino("", [], { logger });
	app.get("/", () => "ok");
	app.onResponse((_req, _info, _ctx, res) =>
		res.status === 200 ? new Response(null, { status: 202 }) : undefined,
	);

	const r = await app(request("/"));
	assert.equal(r.status, 202);
	assert.deepEqual(statuses, [202]);
});

test("response hook: a hook that throws fails the request through the error path, once", async () => {
	const { logger, errors, statuses } = recordingLogger();
	const app = demino("", [], { logger });
	let calls = 0;
	let laterCalls = 0;
	let cancelled = false;
	let handled: { message?: string; cause?: string } | undefined;

	app.onResponse(() => {
		calls++;
		throw new Error("hook boom");
	});
	app.onResponse(() => {
		laterCalls++;
	});
	app.error((_req, _info, ctx) => {
		handled = {
			message: ctx.error?.message,
			cause: (ctx.error?.cause as Error | undefined)?.message,
		};
		// falls through to the default error response
	});
	app.get(
		"/",
		() =>
			new Response(
				new ReadableStream({
					cancel() {
						cancelled = true;
					},
				}),
			),
	);

	const r = await app(request("/"));
	assert.equal(r.status, 500);
	// the hooks are not run for the error response: no loop, no second pass
	assert.equal(calls, 1);
	assert.equal(laterCalls, 0);
	// the error took the app's error path: handler, 5xx log, access log
	assert.deepEqual(handled, { message: "Internal Server Error", cause: "hook boom" });
	assert.equal(errors.length, 1);
	assert.equal(errors[0].status, 500);
	assert.match(errors[0].error, /hook boom/);
	assert.deepEqual(statuses, [500]);
	// and the response that was dropped had its body released
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(cancelled, true);
});

test("response hook: a throw carries its status, also on a response that was already an error", async () => {
	const { logger, errors, statuses } = recordingLogger();
	const app = demino("", [], { logger });
	app.get("/", () => "ok");
	app.onResponse((_req, _info, _ctx, res) => {
		if (res.status === 200) throw createHttpError(403);
		if (res.status === 404) throw new Error("hook boom on the 404");
	});

	let r = await app(request("/"));
	assert.equal(r.status, 403);

	r = await app(request("/nope"));
	assert.equal(r.status, 500);
	assert.match(errors.at(-1)?.error ?? "", /hook boom on the 404/);

	// a 4xx is not error-logged, a 5xx is; each request is access-logged once
	assert.equal(errors.length, 1);
	assert.deepEqual(statuses, [403, 500]);
});

test("response hook: not run for a WebSocket upgrade (101)", async () => {
	const app = demino().logger(null);
	let calls = 0;
	// replacing the 101 would abandon the upgrade
	app.onResponse(() => {
		calls++;
		return new Response("hijacked");
	});
	app.get("/ws", (req, info) => {
		assert.ok(info.upgradeWebSocket, "the harness adapter provides the capability");
		const { socket, response } = info.upgradeWebSocket(req);
		socket.onmessage = (e) => socket.send(e.data);
		return response;
	});

	const srv = await startTestServer(app);
	try {
		const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
		const opened = Promise.withResolvers<void>();
		const echoed = Promise.withResolvers<string>();
		const closed = Promise.withResolvers<void>();
		ws.onopen = () => opened.resolve();
		ws.onerror = () => opened.reject(new Error("the upgrade failed"));
		ws.onmessage = (e) => echoed.resolve(e.data);
		ws.onclose = (e) => {
			// an abandoned upgrade is closed by the server: fail, do not hang
			const error = new Error(`closed before the echo (code ${e.code})`);
			opened.reject(error);
			echoed.reject(error);
			closed.resolve();
		};

		await opened.promise;
		ws.send("hi");
		assert.equal(await echoed.promise, "hi");
		ws.close();
		await closed.promise;

		assert.equal(calls, 0);
	} finally {
		await srv.close();
	}
});
