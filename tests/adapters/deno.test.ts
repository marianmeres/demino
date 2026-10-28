import { assert, assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import { demino, type DeminoServeInfo } from "../../src/demino.ts";
import { serve } from "../../src/adapters/deno.ts";
import { serve as serveViaShim } from "../../src/deno.ts";
import { type ServeHandle, toUrl } from "../../src/adapters/types.ts";

/**
 * Deno adapter: `serve()` over `Deno.serve`. Deno-only by nature; once the suite
 * runs on `node:test` this file becomes `test(name, { skip: !isDeno }, …)`.
 */

const silent = { hostname: "127.0.0.1", port: 0, onListen() {} };

Deno.test("deno adapter: listens on port 0 and reports the real port + url", async () => {
	const app = demino();
	app.logger(null);
	app.get("/", () => "hi");

	const srv = await serve(app, silent);
	try {
		assert(srv.port > 0, `expected a real port, got ${srv.port}`);
		assertEquals(srv.hostname, "127.0.0.1");
		assertEquals(srv.url, `http://127.0.0.1:${srv.port}/`);

		const resp = await fetch(srv.url);
		assertEquals(resp.status, 200);
		assertEquals(await resp.text(), "hi");
	} finally {
		await srv.shutdown();
	}
});

Deno.test("deno adapter: onListen receives { hostname, port } matching the handle", async () => {
	let seen: { hostname: string; port: number } | undefined;
	const srv = await serve(() => new Response("x"), {
		hostname: "127.0.0.1",
		port: 0,
		onListen: (addr) => (seen = { hostname: addr.hostname, port: addr.port }),
	});
	try {
		assertEquals(seen, { hostname: "127.0.0.1", port: srv.port });
	} finally {
		await srv.shutdown();
	}
});

Deno.test("deno adapter: defaults are 0.0.0.0 and the url renders it as localhost", async () => {
	// port 0 (not the 8000 default) so the test never collides with a running app
	const srv = await serve(() => new Response("x"), { port: 0, onListen() {} });
	try {
		assertEquals(srv.hostname, "0.0.0.0");
		assertEquals(srv.url, `http://localhost:${srv.port}/`);
		const resp = await fetch(`http://127.0.0.1:${srv.port}/`);
		assertEquals(await resp.text(), "x");
	} finally {
		await srv.shutdown();
	}
});

Deno.test("deno adapter: info.remoteAddr reaches ctx.ip, raw is Deno's own info", async () => {
	let info: DeminoServeInfo | undefined;
	const app = demino();
	app.logger(null);
	app.get("/ip", (_req, i, ctx) => {
		info = i;
		return ctx.ip;
	});

	const srv = await serve(app, silent);
	try {
		const resp = await fetch(`${srv.url}ip`);
		assertEquals(await resp.text(), "127.0.0.1");

		assertEquals(info?.remoteAddr?.hostname, "127.0.0.1");
		assertEquals(info?.remoteAddr?.transport, "tcp");
		assert((info?.remoteAddr?.port ?? 0) > 0, "remoteAddr.port should be set");
		assertEquals(typeof info?.raw, "object");
		assert(info?.raw !== null);
		assertEquals(typeof info?.upgradeWebSocket, "function");
	} finally {
		await srv.shutdown();
	}
});

Deno.test("deno adapter: info.upgradeWebSocket performs an echo upgrade with a subprotocol", async () => {
	const serverClosed = Promise.withResolvers<{ code: number; reason: string }>();
	const app = demino();
	app.logger(null);
	app.get("/echo", (req, info) => {
		const { socket, response } = info.upgradeWebSocket!(req, { protocol: "echo.v1" });
		socket.binaryType = "arraybuffer";
		socket.onmessage = (e) => socket.send(e.data);
		socket.onclose = (e) => serverClosed.resolve({ code: e.code, reason: e.reason });
		return response;
	});

	// `webSockets` is a Node-only option; on Deno the capability is always present
	const srv = await serve(app, { ...silent, webSockets: false });
	try {
		const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/echo`, [
			"echo.v1",
			"echo.v0",
		]);
		ws.binaryType = "arraybuffer";
		const opened = Promise.withResolvers<void>();
		const inbox: (string | ArrayBuffer)[] = [];
		const waiters: ((d: string | ArrayBuffer) => void)[] = [];
		ws.onopen = () => opened.resolve();
		ws.onerror = () => opened.reject(new Error("ws error"));
		ws.onmessage = (e) => {
			const w = waiters.shift();
			if (w) w(e.data);
			else inbox.push(e.data);
		};
		const next = (): Promise<string | ArrayBuffer> =>
			inbox.length
				? Promise.resolve(inbox.shift()!)
				: new Promise((r) => waiters.push(r));

		await opened.promise;
		assertEquals(ws.protocol, "echo.v1");

		ws.send("hello");
		assertEquals(await next(), "hello");

		ws.send(new Uint8Array([1, 2, 3]));
		const bin = await next();
		assert(bin instanceof ArrayBuffer);
		assertEquals([...new Uint8Array(bin)], [1, 2, 3]);

		const closed = new Promise<CloseEvent>((r) => (ws.onclose = r));
		ws.close(4000, "done");
		await closed;
		assertEquals(await serverClosed.promise, { code: 4000, reason: "done" });
	} finally {
		await srv.shutdown();
	}
});

Deno.test("deno adapter: shutdown() resolves finished and is idempotent", async () => {
	const srv = await serve(() => new Response("x"), silent);
	let finished = false;
	srv.finished.then(() => (finished = true));

	await srv.shutdown();
	await srv.finished;
	assert(finished, "finished should have resolved after shutdown()");

	// a second shutdown is a no-op, not an error
	await srv.shutdown();

	await assertRejects(() => fetch(`http://127.0.0.1:${srv.port}/`));
});

Deno.test("deno adapter: signal.abort() shuts the server down", async () => {
	const ac = new AbortController();
	const srv = await serve(() => new Response("x"), { ...silent, signal: ac.signal });

	const resp = await fetch(srv.url);
	assertEquals(resp.status, 200);
	await resp.body?.cancel();

	ac.abort();
	await srv.finished;

	await assertRejects(() => fetch(srv.url));
	// shutdown after an abort is still safe
	await srv.shutdown();
});

Deno.test("deno adapter: onError is forwarded", async () => {
	const boom = () => {
		throw new Error("boom");
	};

	const custom = await serve(boom, {
		...silent,
		onError: (e) => new Response(`custom: ${(e as Error).message}`, { status: 503 }),
	});
	try {
		const resp = await fetch(custom.url);
		assertEquals(resp.status, 503);
		assertEquals(await resp.text(), "custom: boom");
	} finally {
		await custom.shutdown();
	}
});

Deno.test("deno adapter: ref/unref are wired", async () => {
	const srv = await serve(() => new Response("x"), silent);
	try {
		srv.unref();
		srv.ref();
	} finally {
		await srv.shutdown();
	}
});

Deno.test("deno adapter: the flat shim src/deno.ts re-exports serve", () => {
	assertStrictEquals(serveViaShim, serve);
	// and the handle type is reachable from the shim too (type-level)
	const _h: ServeHandle | null = null;
	assertEquals(_h, null);
});

Deno.test("adapters: toUrl brackets IPv6 and renders unspecified addresses as localhost", () => {
	assertEquals(toUrl({ hostname: "127.0.0.1", port: 8000 }), "http://127.0.0.1:8000/");
	assertEquals(toUrl({ hostname: "0.0.0.0", port: 8000 }), "http://localhost:8000/");
	assertEquals(toUrl({ hostname: "::", port: 8000 }), "http://localhost:8000/");
	assertEquals(toUrl({ hostname: "::1", port: 3000 }), "http://[::1]:3000/");
	assertEquals(toUrl({ hostname: "example.com", port: 80 }), "http://example.com:80/");
});
