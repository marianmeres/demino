import assert from "node:assert/strict";
import { test } from "node:test";
import { serve } from "../../src/adapters/deno.ts";
import { type ServeHandle, toUrl } from "../../src/adapters/types.ts";
import { type DeminoServeInfo, demino } from "../../src/demino.ts";
import { serve as serveViaShim } from "../../src/deno.ts";
import { isDeno } from "../_utils.ts";

/**
 * Deno adapter: `serve()` over `Deno.serve`. The server tests are Deno-only by
 * nature (`{ skip: !isDeno }` elsewhere); the shim and `toUrl` checks run on every
 * runtime.
 */

const silent = { hostname: "127.0.0.1", port: 0, onListen() {} };

test("deno adapter: listens on port 0 and reports the real port + url", {
	skip: !isDeno,
}, async () => {
	const app = demino();
	app.logger(null);
	app.get("/", () => "hi");

	const srv = await serve(app, silent);
	try {
		assert.ok(srv.port > 0, `expected a real port, got ${srv.port}`);
		assert.equal(srv.hostname, "127.0.0.1");
		assert.equal(srv.url, `http://127.0.0.1:${srv.port}/`);

		const resp = await fetch(srv.url);
		assert.equal(resp.status, 200);
		assert.equal(await resp.text(), "hi");
	} finally {
		await srv.shutdown();
	}
});

test("deno adapter: onListen receives { hostname, port } matching the handle", {
	skip: !isDeno,
}, async () => {
	let seen: { hostname: string; port: number } | undefined;
	const srv = await serve(() => new Response("x"), {
		hostname: "127.0.0.1",
		port: 0,
		onListen: (addr) => (seen = { hostname: addr.hostname, port: addr.port }),
	});
	try {
		assert.deepEqual(seen, { hostname: "127.0.0.1", port: srv.port });
	} finally {
		await srv.shutdown();
	}
});

test("deno adapter: defaults are 0.0.0.0 and the url renders it as localhost", {
	skip: !isDeno,
}, async () => {
	// port 0 (not the 8000 default) so the test never collides with a running app
	const srv = await serve(() => new Response("x"), { port: 0, onListen() {} });
	try {
		assert.equal(srv.hostname, "0.0.0.0");
		assert.equal(srv.url, `http://localhost:${srv.port}/`);
		const resp = await fetch(`http://127.0.0.1:${srv.port}/`);
		assert.equal(await resp.text(), "x");
	} finally {
		await srv.shutdown();
	}
});

test("deno adapter: info.remoteAddr reaches ctx.ip, raw is Deno's own info", {
	skip: !isDeno,
}, async () => {
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
		assert.equal(await resp.text(), "127.0.0.1");

		assert.equal(info?.remoteAddr?.hostname, "127.0.0.1");
		assert.equal(info?.remoteAddr?.transport, "tcp");
		assert.ok((info?.remoteAddr?.port ?? 0) > 0, "remoteAddr.port should be set");
		assert.equal(typeof info?.raw, "object");
		assert.ok(info?.raw !== null);
		assert.equal(typeof info?.upgradeWebSocket, "function");
	} finally {
		await srv.shutdown();
	}
});

test("deno adapter: info.upgradeWebSocket performs an echo upgrade with a subprotocol", {
	skip: !isDeno,
}, async () => {
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
		assert.equal(ws.protocol, "echo.v1");

		ws.send("hello");
		assert.equal(await next(), "hello");

		ws.send(new Uint8Array([1, 2, 3]));
		const bin = await next();
		assert.ok(bin instanceof ArrayBuffer);
		assert.deepEqual([...new Uint8Array(bin)], [1, 2, 3]);

		const closed = new Promise<CloseEvent>((r) => (ws.onclose = r));
		ws.close(4000, "done");
		await closed;
		assert.deepEqual(await serverClosed.promise, { code: 4000, reason: "done" });
	} finally {
		await srv.shutdown();
	}
});

test("deno adapter: shutdown() resolves finished and is idempotent", {
	skip: !isDeno,
}, async () => {
	const srv = await serve(() => new Response("x"), silent);
	let finished = false;
	srv.finished.then(() => (finished = true));

	await srv.shutdown();
	await srv.finished;
	assert.ok(finished, "finished should have resolved after shutdown()");

	// a second shutdown is a no-op, not an error
	await srv.shutdown();

	await assert.rejects(() => fetch(`http://127.0.0.1:${srv.port}/`));
});

test("deno adapter: signal.abort() shuts the server down", {
	skip: !isDeno,
}, async () => {
	const ac = new AbortController();
	const srv = await serve(() => new Response("x"), {
		...silent,
		signal: ac.signal,
	});

	const resp = await fetch(srv.url);
	assert.equal(resp.status, 200);
	await resp.body?.cancel();

	ac.abort();
	await srv.finished;

	await assert.rejects(() => fetch(srv.url));
	// shutdown after an abort is still safe
	await srv.shutdown();
});

test("deno adapter: onError is forwarded", { skip: !isDeno }, async () => {
	const boom = () => {
		throw new Error("boom");
	};

	const custom = await serve(boom, {
		...silent,
		onError: (e) => new Response(`custom: ${(e as Error).message}`, { status: 503 }),
	});
	try {
		const resp = await fetch(custom.url);
		assert.equal(resp.status, 503);
		assert.equal(await resp.text(), "custom: boom");
	} finally {
		await custom.shutdown();
	}
});

test("deno adapter: ref/unref are wired", { skip: !isDeno }, async () => {
	const srv = await serve(() => new Response("x"), silent);
	try {
		srv.unref();
		srv.ref();
	} finally {
		await srv.shutdown();
	}
});

test("deno adapter: the flat shim src/deno.ts re-exports serve", () => {
	assert.equal(serveViaShim, serve);
	// and the handle type is reachable from the shim too (type-level)
	const _h: ServeHandle | null = null;
	assert.equal(_h, null);
});

test("adapters: toUrl brackets IPv6 and renders unspecified addresses as localhost", () => {
	assert.equal(toUrl({ hostname: "127.0.0.1", port: 8000 }), "http://127.0.0.1:8000/");
	assert.equal(toUrl({ hostname: "0.0.0.0", port: 8000 }), "http://localhost:8000/");
	assert.equal(toUrl({ hostname: "::", port: 8000 }), "http://localhost:8000/");
	assert.equal(toUrl({ hostname: "::1", port: 3000 }), "http://[::1]:3000/");
	assert.equal(toUrl({ hostname: "example.com", port: 80 }), "http://example.com:80/");
});
