import assert from "node:assert/strict";
import { test } from "node:test";
import { createConnection } from "node:net";
import { demino, type DeminoServeInfo } from "../../src/demino.ts";
import { serve } from "../../src/adapters/bun.ts";
import { serve as serveViaShim } from "../../src/bun.ts";
import type { ServeHandle } from "../../src/adapters/types.ts";
import { isBun } from "../_utils.ts";

/**
 * Bun adapter: `serve()` over `Bun.serve` with a per-socket WebSocket facade.
 * The server tests are Bun-only by nature (`{ skip: !isBun }`); the shim check
 * runs on every runtime. The whole suite runs through this adapter under
 * `bun test` (see `tests/_utils.ts`); this file covers the adapter's own edges,
 * the facade above all: Bun fires `open` and delivers frames while the handler
 * is still running, and the facade must hide that behind the Deno-shaped
 * contract (CONNECTING until the 101 is returned, then `open`).
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

/** A client socket with awaitable open/close and a message inbox. */
function connect(url: string, protocols?: string[]) {
	const ws = new WebSocket(url, protocols);
	ws.binaryType = "arraybuffer";
	const opened = Promise.withResolvers<void>();
	const closed = Promise.withResolvers<CloseEvent>();
	const inbox: (string | ArrayBuffer)[] = [];
	const waiters: ((d: string | ArrayBuffer) => void)[] = [];
	ws.onopen = () => opened.resolve();
	ws.onerror = () => opened.reject(new Error("ws error"));
	ws.onclose = (e) => closed.resolve(e);
	ws.onmessage = (e) => {
		const w = waiters.shift();
		if (w) w(e.data);
		else inbox.push(e.data);
	};
	const next = (): Promise<string | ArrayBuffer> =>
		inbox.length
			? Promise.resolve(inbox.shift()!)
			: new Promise((r) => waiters.push(r));
	return { ws, opened: opened.promise, closed: closed.promise, next };
}

// ---------------------------------------------------------------------------
// handle, listen options
// ---------------------------------------------------------------------------

test("bun adapter: listens on port 0 and reports the real port + url", {
	skip: !isBun,
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

test("bun adapter: onListen receives { hostname, port } matching the handle", {
	skip: !isBun,
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

test("bun adapter: defaults are 0.0.0.0 and the url renders it as localhost", {
	skip: !isBun,
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

test("bun adapter: a port in use rejects instead of throwing synchronously", {
	skip: !isBun,
}, async () => {
	const first = await serve(() => new Response("x"), silent);
	try {
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

test("bun adapter: info.remoteAddr reaches ctx.ip, raw is the Bun server", {
	skip: !isBun,
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
		const raw = info?.raw as { requestIP?: unknown; port?: number };
		assert.equal(typeof raw?.requestIP, "function", "raw should be the Bun server");
		assert.equal(raw.port, srv.port);
		assert.equal(typeof info?.upgradeWebSocket, "function");
	} finally {
		await srv.shutdown();
	}
});

test(
	"bun adapter: IPv4-mapped peers on a dual-stack listener are reported as plain IPv4",
	{
		skip: !isBun,
	},
	async (t) => {
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
			assert.equal(
				ip,
				"127.0.0.1",
				`expected the ::ffff: prefix stripped, got ${ip}`,
			);
		} finally {
			await srv.shutdown();
		}
	},
);

test("bun adapter: onError is forwarded, and a failing onError still yields a 500", {
	skip: !isBun,
}, async () => {
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
// WebSocket facade
// ---------------------------------------------------------------------------

test("bun adapter: info.upgradeWebSocket performs an echo upgrade with a subprotocol", {
	skip: !isBun,
}, async () => {
	const serverClosed = Promise.withResolvers<{ code: number; reason: string }>();
	const serverOpened = Promise.withResolvers<void>();
	let status101 = 0;
	let stateAfterUpgrade = -1;
	let stateInOpen = -1;
	let handlerReturned = false;
	let openedAfterReturn = false;
	const app = demino();
	app.logger(null);
	app.get("/echo", (req, info) => {
		const { socket, response } = info.upgradeWebSocket!(req, { protocol: "echo.v1" });
		status101 = response.status;
		stateAfterUpgrade = socket.readyState;
		socket.binaryType = "arraybuffer";
		// Deno semantics: `open` fires after the 101 has been returned
		socket.onopen = () => {
			stateInOpen = socket.readyState;
			openedAfterReturn = handlerReturned;
			serverOpened.resolve();
		};
		socket.onmessage = (e) => socket.send(e.data);
		socket.onclose = (e) => serverClosed.resolve({ code: e.code, reason: e.reason });
		handlerReturned = true;
		return response;
	});

	// `webSockets` is a Node-only option; on Bun the capability is always present
	const srv = await serve(app, { ...silent, webSockets: false });
	try {
		const { ws, opened, closed, next } = connect(
			`ws://127.0.0.1:${srv.port}/echo`,
			["echo.v1", "echo.v0"],
		);
		await timed(opened, 3000, "client open");
		assert.equal(ws.protocol, "echo.v1");
		assert.equal(status101, 101);
		await timed(serverOpened.promise, 3000, "server-side open event");
		assert.equal(stateAfterUpgrade, WebSocket.CONNECTING);
		assert.equal(stateInOpen, WebSocket.OPEN);
		assert.ok(
			openedAfterReturn,
			"server `open` must fire after the handler returned",
		);

		ws.send("hello");
		assert.equal(await timed(next(), 3000, "text echo"), "hello");

		ws.send(new Uint8Array([1, 2, 3]));
		const bin = await timed(next(), 3000, "binary echo");
		assert.ok(bin instanceof ArrayBuffer);
		assert.deepEqual([...new Uint8Array(bin)], [1, 2, 3]);

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

test("bun adapter: a message sent by the handler before `open` is delivered first", {
	skip: !isBun,
}, async () => {
	const app = demino();
	app.logger(null);
	app.get("/greet", async (req, info) => {
		const { socket, response } = info.upgradeWebSocket!(req);
		// still CONNECTING (the facade queues or forwards, either way it arrives)
		socket.send("welcome");
		await sleep(30);
		socket.onopen = () => socket.send("opened");
		return response;
	});

	const srv = await serve(app, silent);
	try {
		const { ws, opened, next } = connect(`ws://127.0.0.1:${srv.port}/greet`);
		await timed(opened, 3000, "client open");
		assert.equal(await timed(next(), 3000, "the early frame"), "welcome");
		assert.equal(await timed(next(), 3000, "the open frame"), "opened");
		ws.close();
	} finally {
		await srv.shutdown();
	}
});

test(
	"bun adapter: frames sent before the handler returns are held, server close propagates",
	{
		skip: !isBun,
	},
	async () => {
		// the client fires a message right after its handshake; the handler is
		// still awaiting when it arrives (Bun delivers it at once), so the facade
		// must hold it until the handler has committed and installed `onmessage`
		const got = Promise.withResolvers<string>();
		let stateInMessage = -1;
		const app = demino();
		app.logger(null);
		app.get("/slow", async (req, info) => {
			const { socket, response } = info.upgradeWebSocket!(req);
			await sleep(50);
			socket.onmessage = (e) => {
				stateInMessage = socket.readyState;
				got.resolve(String(e.data));
				socket.close(4001, "server-bye");
			};
			return response;
		});

		const srv = await serve(app, silent);
		try {
			const { ws, closed } = connect(`ws://127.0.0.1:${srv.port}/slow`);
			ws.onopen = () => ws.send("early");
			assert.equal(await timed(got.promise, 3000, "the early frame"), "early");
			assert.equal(stateInMessage, WebSocket.OPEN);
			const ev = await timed(closed, 3000, "client close");
			assert.equal(ev.code, 4001);
			assert.equal(ev.reason, "server-bye");
		} finally {
			await srv.shutdown();
		}
	},
);

test(
	"bun adapter: a client that closes before the handler returns still gets its close event",
	{
		skip: !isBun,
	},
	async () => {
		const events: string[] = [];
		const serverClosed = Promise.withResolvers<CloseEvent>();
		const app = demino();
		app.logger(null);
		app.get("/ws", async (req, info) => {
			const { socket, response } = info.upgradeWebSocket!(req);
			socket.onopen = () => events.push("open");
			socket.onmessage = (e) => events.push(`message:${e.data}`);
			socket.onclose = (e) => {
				events.push(`close:${e.code}`);
				serverClosed.resolve(e);
			};
			// long enough for the client to send and close meanwhile
			await sleep(100);
			return response;
		});

		const srv = await serve(app, silent);
		try {
			const { ws, opened, closed } = connect(`ws://127.0.0.1:${srv.port}/ws`);
			await timed(opened, 3000, "client open");
			ws.send("bye-soon");
			ws.close(4009, "early-bye");
			await timed(closed, 3000, "client close");
			const ev = await timed(serverClosed.promise, 3000, "server close");
			assert.equal(ev.code, 4009);
			assert.equal(ev.reason, "early-bye");
			assert.equal(ev.wasClean, true);
			// replayed in order, after the 101: open, the frame, then the close
			assert.deepEqual(events, ["open", "message:bye-soon", "close:4009"]);
		} finally {
			await srv.shutdown();
		}
	},
);

test(
	"bun adapter: a handler that upgraded but returned another response closes with 1011",
	{
		skip: !isBun,
	},
	async () => {
		const serverEvents: string[] = [];
		const app = demino();
		app.logger(null);
		app.get("/ws", (req, info) => {
			const { socket } = info.upgradeWebSocket!(req);
			socket.onopen = () => serverEvents.push("open");
			socket.onclose = (e) => serverEvents.push(`close:${e.code}`);
			return new Response("changed my mind", { status: 200 });
		});

		const srv = await serve(app, silent);
		try {
			const { closed } = connect(`ws://127.0.0.1:${srv.port}/ws`);
			const ev = await timed(closed, 3000, "client close");
			assert.equal(ev.code, 1011);
			assert.equal(ev.reason, "Upgrade abandoned by the handler");
			await sleep(20);
			assert.deepEqual(
				serverEvents,
				["close:1011"],
				"no `open` on an abandoned upgrade",
			);
		} finally {
			await srv.shutdown();
		}
	},
);

test(
	"bun adapter: upgradeWebSocket on a plain request throws a TypeError (Deno parity)",
	{
		skip: !isBun,
	},
	async () => {
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
	},
);

test(
	"bun adapter: close() validates like the standard socket, binaryType blob is honoured",
	{
		skip: !isBun,
	},
	async () => {
		const checks = Promise.withResolvers<
			{ invalidCode: string; longReason: string }
		>();
		const gotBlob = Promise.withResolvers<boolean>();
		const app = demino();
		app.logger(null);
		app.get("/ws", (req, info) => {
			const { socket, response } = info.upgradeWebSocket!(req);
			socket.binaryType = "blob";
			socket.onopen = () => {
				const name = (fn: () => void) => {
					try {
						fn();
						return "no throw";
					} catch (e) {
						return (e as DOMException).name;
					}
				};
				checks.resolve({
					invalidCode: name(() => socket.close(1006)),
					longReason: name(() => socket.close(4000, "x".repeat(124))),
				});
			};
			socket.onmessage = (e) => {
				gotBlob.resolve(e.data instanceof Blob);
				socket.close(1000, "ok");
			};
			return response;
		});

		const srv = await serve(app, silent);
		try {
			const { ws, opened, closed } = connect(`ws://127.0.0.1:${srv.port}/ws`);
			await timed(opened, 3000, "client open");
			assert.deepEqual(await timed(checks.promise, 3000, "close() checks"), {
				invalidCode: "InvalidAccessError",
				longReason: "SyntaxError",
			});
			// the socket survived the rejected close() calls
			ws.send(new Uint8Array([1]));
			assert.equal(await timed(gotBlob.promise, 3000, "the binary frame"), true);
			const ev = await timed(closed, 3000, "client close");
			assert.equal(ev.code, 1000);
			assert.equal(ev.reason, "ok");
		} finally {
			await srv.shutdown();
		}
	},
);

// ---------------------------------------------------------------------------
// shutdown
// ---------------------------------------------------------------------------

test("bun adapter: shutdown() resolves finished and is idempotent", {
	skip: !isBun,
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

test("bun adapter: shutdown() closes WebSockets with 1001 and resolves promptly", {
	skip: !isBun,
}, async () => {
	const app = demino();
	app.logger(null);
	app.get("/ws", (req, info) => {
		const { socket, response } = info.upgradeWebSocket!(req);
		socket.onmessage = () => {};
		return response;
	});
	const srv = await serve(app, silent);
	const { opened, closed } = connect(`ws://127.0.0.1:${srv.port}/ws`);
	await timed(opened, 3000, "client open");

	const started = Date.now();
	await timed(srv.shutdown(), 4000, "shutdown with an open WebSocket");
	assert.ok(Date.now() - started < 4000);
	const ev = await timed(closed, 3000, "client close");
	assert.equal(ev.code, 1001);
	assert.equal(ev.reason, "Server shutting down");
});

test("bun adapter: shutdown() resolves within 6 s with a held-open in-flight request", {
	skip: !isBun,
	// waits out the 5 s force-close grace period on purpose; `bun test` defaults to 5 s
	timeout: 10_000,
}, async () => {
	const never = new Promise<Response>(() => {});
	const reached = Promise.withResolvers<void>();
	const srv = await serve((req) => {
		if (new URL(req.url).pathname !== "/hang") return new Response("x");
		reached.resolve();
		return never;
	}, silent);

	// one idle keep-alive connection and one request that never completes (force-closed)
	const idle = createConnection({ host: "127.0.0.1", port: srv.port });
	const hanging = createConnection({ host: "127.0.0.1", port: srv.port });
	idle.on("error", () => {});
	hanging.on("error", () => {});
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
		await timed(hangingClosed, 1000, "in-flight connection close");
		await assert.rejects(() => fetch(srv.url));
	} finally {
		idle.destroy();
		hanging.destroy();
		await srv.shutdown();
	}
});

test("bun adapter: signal.abort() closes the server and its connections at once", {
	skip: !isBun,
}, async () => {
	const ac = new AbortController();
	const never = new Promise<Response>(() => {});
	const reached = Promise.withResolvers<void>();
	const srv = await serve((req) => {
		if (new URL(req.url).pathname !== "/hang") return new Response("x");
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
	await assert.rejects(() => fetch(srv.url));
	// shutdown after an abort is still safe
	await srv.shutdown();
});

test("bun adapter: an aborted signal force-closes open WebSockets (1006)", {
	skip: !isBun,
}, async () => {
	const ac = new AbortController();
	const serverClosed = Promise.withResolvers<CloseEvent>();
	const app = demino();
	app.logger(null);
	app.get("/ws", (req, info) => {
		const { socket, response } = info.upgradeWebSocket!(req);
		socket.onclose = (e) => serverClosed.resolve(e);
		return response;
	});
	const srv = await serve(app, { ...silent, signal: ac.signal });
	const { opened, closed } = connect(`ws://127.0.0.1:${srv.port}/ws`);
	await timed(opened, 3000, "client open");

	ac.abort();
	await timed(srv.finished, 2000, "finished after abort");
	const ev = await timed(serverClosed.promise, 3000, "server-side close");
	assert.equal(ev.code, 1006);
	assert.equal(ev.wasClean, false);
	await timed(closed, 3000, "client close");
});

test("bun adapter: ref/unref are wired", { skip: !isBun }, async () => {
	const srv = await serve(() => new Response("x"), silent);
	try {
		srv.unref();
		srv.ref();
	} finally {
		await srv.shutdown();
	}
});

// the one test that needs the `Bun` global to be absent: it runs on Deno and Node only
test("bun adapter: serve() rejects without the Bun global", { skip: isBun }, async () => {
	await assert.rejects(serve(() => new Response("x"), silent), /`Bun` is not defined/);
});

test("bun adapter: the flat shim src/bun.ts re-exports serve", () => {
	assert.equal(serveViaShim, serve);
	// and the handle type is reachable from the shim too (type-level)
	const _h: ServeHandle | null = null;
	assert.equal(_h, null);
});
