import assert from "node:assert/strict";
import { test } from "node:test";
import { createConnection } from "node:net";
import type { IncomingMessage } from "node:http";
import { WebSocketServer } from "ws";
import { demino, type DeminoServeInfo } from "../../src/demino.ts";
import { serve, wsEngineUsable } from "../../src/adapters/node.ts";
import { serve as serveViaShim } from "../../src/node.ts";
import type { ServeHandle } from "../../src/adapters/types.ts";

/**
 * Node adapter: `serve()` over an own `node:http` bridge. These tests run on
 * both runtimes (Deno through its `node:http` compatibility) - a divergence is
 * a finding, not something to paper over. The whole suite runs through this
 * adapter under Node (see `tests/_utils.ts`); this file covers the bridge's own
 * edges.
 */

const silent = { hostname: "127.0.0.1", port: 0, onListen() {} };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Fails fast instead of hanging the runner when an expected event never comes. */
function timed<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
	let tid: ReturnType<typeof setTimeout>;
	const timeout = new Promise<never>((_, reject) => {
		tid = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
	});
	return Promise.race([p, timeout]).finally(() => clearTimeout(tid));
}

/**
 * Writes `head` (and later `body`) over a plain TCP socket and resolves with
 * everything received once `until(received)` holds or the server closed the
 * connection. `onHead` fires once the first response head is complete, so a
 * caller can react to a `100 Continue`.
 */
function rawRequest(
	port: number,
	head: string,
	options: {
		until?: (received: string) => boolean;
		onHead?: (sock: ReturnType<typeof createConnection>) => void;
	} = {},
): Promise<string> {
	return new Promise((resolve, reject) => {
		const sock = createConnection(
			{ host: "127.0.0.1", port },
			() => sock.write(head),
		);
		let received = "";
		let headSeen = false;
		let settled = false;
		const settle = (err?: Error) => {
			if (settled) return;
			settled = true;
			sock.destroy();
			if (err) reject(err);
			else resolve(received);
		};
		sock.setEncoding("utf8");
		sock.on("data", (chunk: string) => {
			received += chunk;
			if (!headSeen && received.includes("\r\n\r\n")) {
				headSeen = true;
				options.onHead?.(sock);
			}
			if (options.until ? options.until(received) : headSeen) settle();
		});
		sock.on("end", () => settle());
		sock.on("close", () => settle());
		sock.on("error", (e) => settle(e));
	});
}

/** A raw WebSocket handshake head for `path`. */
function upgradeHead(port: number, path: string): string {
	return [
		`GET ${path} HTTP/1.1`,
		`Host: 127.0.0.1:${port}`,
		`Connection: Upgrade`,
		`Upgrade: websocket`,
		`Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==`,
		`Sec-WebSocket-Version: 13`,
		``,
		``,
	].join("\r\n");
}

async function sha256(data: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join(
		"",
	);
}

// ---------------------------------------------------------------------------
// handle, listen options
// ---------------------------------------------------------------------------

test("node adapter: listens on port 0 and reports the real port + url", async () => {
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

test("node adapter: onListen receives { hostname, port } matching the handle", async () => {
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

test("node adapter: defaults are 0.0.0.0 and the url renders it as localhost", async () => {
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

test("node adapter: a port in use rejects instead of throwing synchronously", async () => {
	const first = await serve(() => new Response("x"), silent);
	try {
		// `code` is the contract; the message is the runtime's
		await assert.rejects(
			serve(() => new Response("y"), { ...silent, port: first.port }),
			(e: unknown) => (e as { code?: string }).code === "EADDRINUSE",
		);
	} finally {
		await first.shutdown();
	}
});

// ---------------------------------------------------------------------------
// info
// ---------------------------------------------------------------------------

test("node adapter: info.remoteAddr reaches ctx.ip, raw is the IncomingMessage", async () => {
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
		const raw = info?.raw as IncomingMessage;
		assert.ok(Array.isArray(raw?.rawHeaders), "raw should be the IncomingMessage");
		assert.equal(raw.url, "/ip");
		assert.equal(typeof info?.upgradeWebSocket, "function");
	} finally {
		await srv.shutdown();
	}
});

test("node adapter: IPv4-mapped peers on a dual-stack listener are reported as plain IPv4", async (t) => {
	let ip = "";
	const app = demino();
	app.logger(null);
	app.get("/ip", (_req, _info, ctx) => (ip = ctx.ip));

	let srv: ServeHandle;
	try {
		srv = await serve(app, { ...silent, hostname: "::" });
	} catch {
		t.skip("no IPv6 on this host");
		return;
	}
	try {
		const resp = await fetch(`http://127.0.0.1:${srv.port}/ip`);
		assert.equal(resp.status, 200);
		if (ip === "::1") {
			// not a dual-stack socket on this host (IPV6_V6ONLY): nothing to normalise
			t.skip("listener is IPv6-only");
			return;
		}
		assert.equal(ip, "127.0.0.1", `expected the ::ffff: prefix stripped, got ${ip}`);
	} finally {
		await srv.shutdown();
	}
});

// ---------------------------------------------------------------------------
// request bridge
// ---------------------------------------------------------------------------

test("node adapter: duplicate request headers survive (rawHeaders), cookies merge", async () => {
	let multi: string | null = null;
	let cookie: string | null = null;
	const srv = await serve((req) => {
		multi = req.headers.get("x-multi");
		cookie = req.headers.get("cookie");
		return new Response("ok");
	}, silent);
	try {
		const raw = await rawRequest(
			srv.port,
			[
				`GET /h HTTP/1.1`,
				`Host: 127.0.0.1:${srv.port}`,
				`X-Multi: a`,
				`X-Multi: b`,
				`Cookie: s=1`,
				`Cookie: t=2`,
				`Connection: close`,
				``,
				``,
			].join("\r\n"),
		);
		assert.match(raw, /^HTTP\/1\.1 200/);
		assert.equal(multi, "a, b");
		// both lines reached the `Request`; how `Headers` joins repeated `Cookie`
		// is the runtime's call (undici: "; " per RFC 6265, Deno: ", ")
		assert.match(cookie ?? "", /^s=1[;,] t=2$/);
	} finally {
		await srv.shutdown();
	}
});

test("node adapter: HTTP/1.0 request without Host resolves against the listener", async () => {
	const srv = await serve((req) => new Response(new URL(req.url).host), silent);
	try {
		const raw = await rawRequest(
			srv.port,
			`GET /nohost HTTP/1.0\r\n\r\n`,
			{ until: (r) => r.includes(`127.0.0.1:${srv.port}`) },
		);
		// Node answers an HTTP/1.0 request with an HTTP/1.1 status line (allowed)
		assert.match(raw, /^HTTP\/1\.[01] 200/);
		assert.ok(raw.endsWith(`127.0.0.1:${srv.port}`), `body missing in: ${raw}`);
	} finally {
		await srv.shutdown();
	}
});

test("node adapter: a Host header that makes no URL is a 400, not a crash", async () => {
	let reached = false;
	const srv = await serve(() => {
		reached = true;
		return new Response("ok");
	}, silent);
	try {
		const raw = await rawRequest(
			srv.port,
			`GET / HTTP/1.1\r\nHost: bad host\r\nConnection: close\r\n\r\n`,
		);
		assert.match(raw, /^HTTP\/1\.1 400/);
		assert.equal(reached, false, "the handler must not see an unparseable request");

		// and the server is still fine
		const resp = await fetch(srv.url);
		assert.equal(resp.status, 200);
	} finally {
		await srv.shutdown();
	}
});

test("node adapter: req.body is null without a body, a stream with one", async () => {
	const seen: Record<string, string> = {};
	const srv = await serve(async (req) => {
		seen[req.method + (req.headers.get("x-case") ?? "")] = req.body === null
			? "null"
			: `stream:${await req.text()}`;
		return new Response("ok");
	}, silent);
	try {
		await fetch(srv.url);
		await fetch(srv.url, { method: "DELETE" });
		await fetch(srv.url, {
			method: "POST",
			body: "",
			headers: { "x-case": "empty" },
		});
		await fetch(srv.url, { method: "POST", body: "abc" });
		assert.deepEqual(seen, {
			GET: "null",
			DELETE: "null",
			POSTempty: "null",
			POST: "stream:abc",
		});
	} finally {
		await srv.shutdown();
	}
});

test("node adapter: streams a > 1 MiB request body to a slow consumer (backpressure)", async () => {
	const size = 1.5 * 1024 * 1024;
	const payload = new Uint8Array(size);
	for (let i = 0; i < size; i++) payload[i] = (i * 7) & 0xff;
	const expected = await sha256(payload);

	let chunks = 0;
	const srv = await serve(async (req) => {
		const reader = req.body!.getReader();
		const parts: Uint8Array[] = [];
		let total = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			parts.push(value);
			total += value.byteLength;
			chunks++;
			// the slow consumer: the sender must be held back, not buffered in RAM
			await sleep(1);
		}
		const all = new Uint8Array(total);
		let off = 0;
		for (const p of parts) {
			all.set(p, off);
			off += p.byteLength;
		}
		return Response.json({ total, hash: await sha256(all) });
	}, silent);
	try {
		const resp = await fetch(srv.url, { method: "POST", body: payload });
		assert.equal(resp.status, 200);
		assert.deepEqual(await resp.json(), { total: size, hash: expected });
		assert.ok(
			chunks > 1,
			`expected the body to arrive in several chunks, got ${chunks}`,
		);
	} finally {
		await srv.shutdown();
	}
});

test("node adapter: Expect: 100-continue POST succeeds", async () => {
	const srv = await serve(
		async (req) => new Response(`got:${await req.text()}`),
		silent,
	);
	try {
		const body = "hello";
		const raw = await rawRequest(
			srv.port,
			[
				`POST /expect HTTP/1.1`,
				`Host: 127.0.0.1:${srv.port}`,
				`Content-Length: ${body.length}`,
				`Expect: 100-continue`,
				`Connection: close`,
				``,
				``,
			].join("\r\n"),
			{
				onHead: (sock) => sock.write(body),
				until: (r) => r.includes("got:hello"),
			},
		);
		assert.match(raw, /^HTTP\/1\.1 100 Continue\r\n/);
		assert.match(raw, /\r\nHTTP\/1\.1 200/);
	} finally {
		await srv.shutdown();
	}
});

// ---------------------------------------------------------------------------
// response bridge
// ---------------------------------------------------------------------------

test("node adapter: multi-value Set-Cookie reaches the client intact", async () => {
	const srv = await serve(() => {
		const headers = new Headers({ "x-one": "1" });
		headers.append("set-cookie", "a=1; Path=/; HttpOnly");
		headers.append("set-cookie", "b=2; Path=/x; Secure");
		return new Response("ok", { headers });
	}, silent);
	try {
		const resp = await fetch(srv.url);
		assert.equal(resp.headers.get("x-one"), "1");
		assert.deepEqual(resp.headers.getSetCookie(), [
			"a=1; Path=/; HttpOnly",
			"b=2; Path=/x; Secure",
		]);
	} finally {
		await srv.shutdown();
	}
});

test("node adapter: statusText and an empty body's content-length are on the wire", async () => {
	const srv = await serve(
		(req) =>
			new URL(req.url).pathname === "/teapot"
				? new Response("short and stout", {
					status: 418,
					statusText: "I'm a teapot",
				})
				: new Response(null, { status: 200 }),
		silent,
	);
	try {
		const teapot = await rawRequest(
			srv.port,
			`GET /teapot HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`,
		);
		assert.match(teapot, /^HTTP\/1\.1 418 I'm a teapot\r\n/);

		const empty = await rawRequest(
			srv.port,
			`GET /empty HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`,
		);
		assert.match(empty, /^HTTP\/1\.1 200/);
		assert.match(empty, /\r\ncontent-length: 0\r\n/i);
	} finally {
		await srv.shutdown();
	}
});

test("node adapter: HEAD never reads the body and cancels it", async () => {
	let pulls = 0;
	let cancelled = false;
	const app = demino();
	app.logger(null);
	app.get("/big", () =>
		new Response(
			new ReadableStream({
				pull(controller) {
					pulls++;
					controller.enqueue(new TextEncoder().encode("x".repeat(1024)));
				},
				cancel() {
					cancelled = true;
				},
			}, { highWaterMark: 0 }),
			{ headers: { "x-kind": "stream" } },
		));

	const srv = await serve(app, silent);
	try {
		const resp = await fetch(`${srv.url}big`, { method: "HEAD" });
		assert.equal(resp.status, 200);
		assert.equal(resp.headers.get("x-kind"), "stream");
		assert.equal(await resp.text(), "");
		assert.equal(pulls, 0, "HEAD must not read the body");
		assert.equal(cancelled, true, "the unread body must be cancelled");
	} finally {
		await srv.shutdown();
	}
});

test("node adapter: a client that disconnects cancels the response stream and fires req.signal", async () => {
	const cancelled = Promise.withResolvers<void>();
	const aborted = Promise.withResolvers<void>();
	const srv = await serve((req) => {
		req.signal.addEventListener("abort", () => aborted.resolve());
		let tid: ReturnType<typeof setInterval>;
		return new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					const chunk = new TextEncoder().encode("tick\n");
					tid = setInterval(() => controller.enqueue(chunk), 5);
				},
				cancel() {
					clearInterval(tid);
					cancelled.resolve();
				},
			}),
		);
	}, silent);
	try {
		const ac = new AbortController();
		const resp = await fetch(srv.url, { signal: ac.signal });
		const reader = resp.body!.getReader();
		const first = await reader.read();
		assert.equal(first.done, false);
		ac.abort();

		await timed(cancelled.promise, 3000, "the response stream to be cancelled");
		await timed(aborted.promise, 3000, "req.signal to abort");
	} finally {
		await srv.shutdown();
	}
});

test("node adapter: large streamed response arrives whole (write backpressure)", async () => {
	const chunk = new Uint8Array(64 * 1024).fill(0x61);
	const chunks = 48; // 3 MiB
	const srv = await serve(() =>
		new Response(
			new ReadableStream({
				start(controller) {
					for (let i = 0; i < chunks; i++) controller.enqueue(chunk);
					controller.close();
				},
			}),
		), silent);
	try {
		const resp = await fetch(srv.url);
		const buf = new Uint8Array(await resp.arrayBuffer());
		assert.equal(buf.byteLength, chunk.byteLength * chunks);
		assert.equal(buf[0], 0x61);
		assert.equal(buf[buf.byteLength - 1], 0x61);
	} finally {
		await srv.shutdown();
	}
});

test("node adapter: onError is forwarded, and a failing onError still yields a 500", async () => {
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

	const broken = await serve(boom, {
		...silent,
		onError: () => {
			throw new Error("onError itself broke");
		},
	});
	try {
		const resp = await fetch(broken.url);
		assert.equal(resp.status, 500);
	} finally {
		await broken.shutdown();
	}
});

// ---------------------------------------------------------------------------
// WebSocket upgrades (via `ws`)
// ---------------------------------------------------------------------------

test("node adapter: info.upgradeWebSocket performs an echo upgrade with a subprotocol", async () => {
	const serverClosed = Promise.withResolvers<{ code: number; reason: string }>();
	const serverOpened = Promise.withResolvers<void>();
	let status101 = 0;
	const app = demino();
	app.logger(null);
	app.get("/echo", (req, info) => {
		const { socket, response } = info.upgradeWebSocket!(req, { protocol: "echo.v1" });
		status101 = response.status;
		socket.binaryType = "arraybuffer";
		// Deno semantics: `open` fires after the 101 has been returned
		socket.onopen = () => serverOpened.resolve();
		socket.onmessage = (e) => socket.send(e.data);
		socket.onclose = (e) => serverClosed.resolve({ code: e.code, reason: e.reason });
		return response;
	});

	const srv = await serve(app, silent);
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

		await timed(opened.promise, 3000, "client open");
		assert.equal(ws.protocol, "echo.v1");
		assert.equal(status101, 101);
		await timed(serverOpened.promise, 3000, "server-side open event");

		ws.send("hello");
		assert.equal(await timed(next(), 3000, "text echo"), "hello");

		ws.send(new Uint8Array([1, 2, 3]));
		const bin = await timed(next(), 3000, "binary echo");
		assert.ok(bin instanceof ArrayBuffer);
		assert.deepEqual([...new Uint8Array(bin)], [1, 2, 3]);

		const closed = new Promise<CloseEvent>((r) => (ws.onclose = r));
		ws.close(4000, "done");
		await timed(closed, 3000, "client close");
		assert.deepEqual(await timed(serverClosed.promise, 3000, "server close"), {
			code: 4000,
			reason: "done",
		});
	} finally {
		await srv.shutdown();
	}
});

test("node adapter: frames sent before the handler returns are not lost, server close propagates", async () => {
	// the client fires a message right after its handshake; the handler is
	// still awaiting when it arrives, so the adapter must hold it until the
	// handler has committed and installed `onmessage`
	const got = Promise.withResolvers<string>();
	const app = demino();
	app.logger(null);
	app.get("/slow", async (req, info) => {
		const { socket, response } = info.upgradeWebSocket!(req);
		await sleep(50);
		socket.onmessage = (e) => {
			got.resolve(String(e.data));
			socket.close(4001, "server-bye");
		};
		return response;
	});

	const srv = await serve(app, silent);
	try {
		const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/slow`);
		const closed = new Promise<CloseEvent>((r) => (ws.onclose = r));
		ws.onopen = () => ws.send("early");
		assert.equal(await timed(got.promise, 3000, "the early frame"), "early");
		const ev = await timed(closed, 3000, "client close");
		assert.equal(ev.code, 4001);
		assert.equal(ev.reason, "server-bye");
	} finally {
		await srv.shutdown();
	}
});

test("node adapter: an upgrade request to a route answering 401 gets a raw 401 on the socket", async () => {
	const app = demino();
	app.logger(null);
	app.get("/ws", () =>
		new Response("nope", {
			status: 401,
			headers: { "www-authenticate": "Bearer", "x-reason": "token" },
		}));

	const srv = await serve(app, silent);
	try {
		const raw = await rawRequest(srv.port, upgradeHead(srv.port, "/ws"), {
			until: (r) => r.endsWith("nope"),
		});
		assert.match(raw, /^HTTP\/1\.1 401 Unauthorized\r\n/);
		assert.match(raw, /\r\nwww-authenticate: Bearer\r\n/);
		assert.match(raw, /\r\nx-reason: token\r\n/);
		assert.match(raw, /\r\ncontent-length: 4\r\n/);
		assert.match(raw, /\r\nconnection: close\r\n/);
		assert.ok(
			raw.endsWith("\r\n\r\nnope"),
			`body missing in: ${JSON.stringify(raw)}`,
		);
	} finally {
		await srv.shutdown();
	}
});

test("node adapter: upgradeWebSocket on a plain request throws a TypeError (Deno parity)", async () => {
	let error: unknown;
	const srv = await serve((req, info) => {
		try {
			info!.upgradeWebSocket!(req);
		} catch (e) {
			error = e;
		}
		return new Response("plain");
	}, silent);
	try {
		const resp = await fetch(srv.url);
		assert.equal(await resp.text(), "plain");
		assert.ok(error instanceof TypeError, `expected a TypeError, got ${error}`);
	} finally {
		await srv.shutdown();
	}
});

test("node adapter: webSockets: false leaves the capability undefined", async () => {
	const seen: string[] = [];
	const srv = await serve((_req, info) => {
		seen.push(typeof info?.upgradeWebSocket);
		return new Response("no ws", { status: 426 });
	}, { ...silent, webSockets: false });
	try {
		const resp = await fetch(srv.url);
		assert.equal(resp.status, 426);
		// an upgrade request still reaches the handler; its answer goes out raw
		const raw = await rawRequest(srv.port, upgradeHead(srv.port, "/"));
		assert.match(raw, /^HTTP\/1\.1 426/);
		assert.deepEqual(seen, ["undefined", "undefined"]);
	} finally {
		await srv.shutdown();
	}
});

test("node adapter: wsEngineUsable accepts only an engine whose sockets can be paused", () => {
	// a substitute `ws` (seen: `options.WebSocket` is null) or anything not shaped like the package
	assert.equal(wsEngineUsable({}), false);
	assert.equal(wsEngineUsable({ options: {} }), false);
	assert.equal(wsEngineUsable({ options: { WebSocket: null } }), false);
	assert.equal(wsEngineUsable({ options: { WebSocket: class {} } }), false);
	class Pausable {
		pause() {}
	}
	assert.equal(wsEngineUsable({ options: { WebSocket: Pausable } }), true);
	// the real package, constructed the way serve() does
	assert.equal(wsEngineUsable(new WebSocketServer({ noServer: true })), true);
});

// ---------------------------------------------------------------------------
// shutdown
// ---------------------------------------------------------------------------

test("node adapter: shutdown() resolves finished and is idempotent", async () => {
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

test("node adapter: shutdown() closes WebSockets with 1001 and resolves promptly", async () => {
	const app = demino();
	app.logger(null);
	app.get("/ws", (req, info) => {
		const { socket, response } = info.upgradeWebSocket!(req);
		socket.onmessage = () => {};
		return response;
	});
	const srv = await serve(app, silent);
	const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
	const closed = new Promise<CloseEvent>((r) => (ws.onclose = r));
	await timed(new Promise<void>((r) => (ws.onopen = () => r())), 3000, "client open");

	const started = Date.now();
	await timed(srv.shutdown(), 4000, "shutdown with an open WebSocket");
	assert.ok(Date.now() - started < 4000);
	const ev = await timed(closed, 3000, "client close");
	assert.equal(ev.code, 1001);
});

test("node adapter: shutdown() resolves within 6 s with a held-open in-flight request", async () => {
	const never = new Promise<Response>(() => {});
	const reached = Promise.withResolvers<void>();
	const srv = await serve((req) => {
		if (new URL(req.url).pathname !== "/hang") return new Response("x");
		reached.resolve();
		return never;
	}, silent);

	// one idle keep-alive connection (closed at once) and one request that never completes (force-closed)
	const idle = createConnection({ host: "127.0.0.1", port: srv.port });
	const hanging = createConnection({ host: "127.0.0.1", port: srv.port });
	idle.on("error", () => {});
	hanging.on("error", () => {});
	const idleClosed = new Promise<void>((r) => idle.once("close", () => r()));
	const hangingClosed = new Promise<void>((r) => hanging.once("close", () => r()));
	try {
		// listeners first, then await: both connects may land in one tick
		const connected = Promise.all([
			new Promise<void>((r) => idle.once("connect", () => r())),
			new Promise<void>((r) => hanging.once("connect", () => r())),
		]);
		await timed(connected, 3000, "raw connects");
		const idleAnswered = new Promise<void>((r) => idle.once("data", () => r()));
		idle.write(`GET / HTTP/1.1\r\nHost: x\r\n\r\n`);
		hanging.write(`GET /hang HTTP/1.1\r\nHost: x\r\n\r\n`);
		await timed(idleAnswered, 3000, "idle response"); // idle has its response, stays open
		await timed(reached.promise, 3000, "the hanging request to reach the handler");

		const started = Date.now();
		await timed(srv.shutdown(), 6000, "shutdown with an in-flight request");
		const took = Date.now() - started;
		assert.ok(took < 6000, `shutdown took ${took}ms`);
		await timed(idleClosed, 1000, "idle connection close");
		await timed(hangingClosed, 1000, "in-flight connection close");
	} finally {
		idle.destroy();
		hanging.destroy();
		await srv.shutdown();
	}
});

test("node adapter: signal.abort() closes the server and its connections at once", async () => {
	const ac = new AbortController();
	const never = new Promise<Response>(() => {});
	const reached = Promise.withResolvers<void>();
	const aborted = Promise.withResolvers<void>();
	const srv = await serve((req) => {
		if (new URL(req.url).pathname !== "/hang") return new Response("x");
		req.signal.addEventListener("abort", () => aborted.resolve());
		reached.resolve();
		return never;
	}, { ...silent, signal: ac.signal });

	const resp = await fetch(srv.url);
	assert.equal(resp.status, 200);
	await resp.body?.cancel();

	// settle-tracking from the start: the rejection lands while we await other things
	const hanging = fetch(`${srv.url}hang`).then(() => "resolved", () => "rejected");
	await timed(reached.promise, 3000, "the hanging request to reach the handler");

	const started = Date.now();
	ac.abort();
	await timed(srv.finished, 2000, "finished after abort");
	assert.ok(Date.now() - started < 2000);

	assert.equal(await timed(hanging, 2000, "the in-flight fetch to settle"), "rejected");
	await timed(aborted.promise, 1000, "the in-flight request's signal");
	await assert.rejects(() => fetch(srv.url));
	// shutdown after an abort is still safe
	await srv.shutdown();
});

test("node adapter: ref/unref are wired", async () => {
	const srv = await serve(() => new Response("x"), silent);
	try {
		srv.unref();
		srv.ref();
	} finally {
		await srv.shutdown();
	}
});

test("node adapter: the flat shim src/node.ts re-exports serve", () => {
	assert.equal(serveViaShim, serve);
	const _h: ServeHandle | null = null;
	assert.equal(_h, null);
});
