import assert from "node:assert/strict";
import { type AddressInfo, createConnection, createServer, type Socket } from "node:net";
import {
	demino,
	type DeminoLogger,
	type DeminoServeInfo,
	type DeminoUpgradeWebSocketOptions,
} from "../../src/demino.ts";
import { proxy } from "../../src/middleware/proxy/proxy.ts";
import { assertResp, runTestServerTests, startTestServer } from "../_utils.ts";

/** Test WS client with awaitable open/close and a message inbox. */
function createWsClient(
	url: string,
	options?: { protocols?: string[]; headers?: HeadersInit },
) {
	// the options bag (protocols + headers) is a non-standard constructor
	// extension, supported by Deno and Node 26 (undici 8); `lib.dom` only
	// knows `string | string[]` as the second argument, so it is typed locally
	// (same as `dialUpstream` in src/middleware/proxy/websocket.ts)
	const WebSocketWithOptions = WebSocket as unknown as new (
		url: string | URL,
		options?: { protocols?: string[]; headers?: HeadersInit },
	) => WebSocket;
	const ws = new WebSocketWithOptions(url, options ?? {});
	ws.binaryType = "arraybuffer";

	const opened = Promise.withResolvers<boolean>();
	const closed = Promise.withResolvers<CloseEvent>();
	const inbox: (string | ArrayBuffer)[] = [];
	const waiters: ((data: string | ArrayBuffer) => void)[] = [];

	ws.onopen = () => opened.resolve(true);
	ws.onerror = () => opened.resolve(false);
	ws.onclose = (e) => {
		opened.resolve(false);
		closed.resolve(e);
	};
	ws.onmessage = (e) => {
		const w = waiters.shift();
		if (w) w(e.data);
		else inbox.push(e.data);
	};

	const nextMessage = (): Promise<string | ArrayBuffer> => {
		if (inbox.length) return Promise.resolve(inbox.shift()!);
		return new Promise((resolve) => waiters.push(resolve));
	};

	return { ws, opened: opened.promise, closed: closed.promise, nextMessage };
}

/**
 * Upgrades through the capability the runtime adapter provides on `info` (the
 * test upstreams are Demino handlers started via `startTestServer`, so it is
 * always present there).
 */
function upgradeWebSocket(
	req: Request,
	info: DeminoServeInfo | undefined,
	options?: DeminoUpgradeWebSocketOptions,
): { socket: WebSocket; response: Response } {
	assert.ok(
		info?.upgradeWebSocket,
		"the harness adapter must provide info.upgradeWebSocket",
	);
	return info.upgradeWebSocket(req, options);
}

/**
 * Sends a raw (fake) upgrade request over a plain TCP socket and resolves with
 * the raw response head: everything up to and including the first blank line,
 * or whatever arrived if the server closed the connection first.
 */
function rawUpgradeRequest(port: number, path: string): Promise<string> {
	const head = [
		`GET ${path} HTTP/1.1`,
		`Host: 127.0.0.1:${port}`,
		`Connection: Upgrade`,
		`Upgrade: websocket`,
		`Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==`,
		`Sec-WebSocket-Version: 13`,
		``,
		``,
	].join("\r\n");

	return new Promise((resolve, reject) => {
		const sock = createConnection({ host: "127.0.0.1", port }, () => {
			sock.write(head);
		});
		let received = "";
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
			if (received.includes("\r\n\r\n")) settle();
		});
		// the server may close before (or without) a full head: return what arrived
		sock.on("end", () => settle());
		sock.on("error", (e) => settle(e));
	});
}

runTestServerTests([
	{
		name: "proxy websocket: tunnels messages, headers and subprotocol",
		fn: async ({ app, base }) => {
			const seen: { url?: string; headers?: Headers } = {};
			const upstreamSocketClosed = Promise.withResolvers<void>();

			const upstream = await startTestServer((req, info) => {
				seen.url = req.url;
				// snapshot: the live req.headers becomes unreadable once the request closes
				seen.headers = new Headers(req.headers);
				// non-upgrade requests keep working over the regular HTTP proxy path
				if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
					return new Response("plain-http");
				}
				const { socket, response } = upgradeWebSocket(req, info, {
					protocol: "chat.v2",
				});
				socket.binaryType = "arraybuffer";
				socket.onmessage = (e) => {
					socket.send(typeof e.data === "string" ? `echo:${e.data}` : e.data);
				};
				socket.onclose = () => upstreamSocketClosed.resolve();
				return response;
			});

			try {
				app.get(
					"/ws/*",
					proxy(`${upstream.base}/*`, { headers: { "x-injected": "yes" } }),
				);

				const { ws, opened, closed, nextMessage } = createWsClient(
					base.replace(/^http/, "ws") + "/ws/room?x=1",
					{
						protocols: ["chat.v1", "chat.v2"],
						headers: { cookie: "session=abc" },
					},
				);

				assert.ok(await opened, "tunnel should open");

				// upstream-negotiated subprotocol is mirrored back to the client
				assert.equal(ws.protocol, "chat.v2");

				// text roundtrip
				ws.send("hello");
				assert.equal(await nextMessage(), "echo:hello");

				// binary roundtrip
				ws.send(new Uint8Array([1, 2, 3]));
				const bin = await nextMessage();
				assert.ok(bin instanceof ArrayBuffer);
				assert.deepEqual([...new Uint8Array(bin)], [1, 2, 3]);

				// path + query forwarded (wildcard target)
				const upstreamUrl = new URL(seen.url!);
				assert.equal(upstreamUrl.pathname, "/ws/room");
				assert.equal(upstreamUrl.search, "?x=1");

				// headers forwarded: cookies, custom injected, loop guard, x-forwarded-*
				assert.equal(seen.headers!.get("cookie"), "session=abc");
				assert.equal(seen.headers!.get("x-injected"), "yes");
				assert.equal(seen.headers!.get("x-demino-proxy-hops"), "1");
				assert.equal(seen.headers!.get("x-forwarded-proto"), "http");
				assert.equal(seen.headers!.get("x-forwarded-host"), new URL(base).host);
				// offered subprotocols reached the upstream via the dial, not raw header copy
				assert.match(seen.headers!.get("sec-websocket-protocol")!, /chat\.v2/);

				ws.close();
				await closed;
				await upstreamSocketClosed.promise;

				// the same route still serves plain HTTP requests
				await assertResp(fetch(`${base}/ws/plain`), 200, "plain-http");
			} finally {
				await upstream.close();
			}
		},
	},
	{
		name: "proxy websocket: propagates close code + reason in both directions",
		fn: async ({ app, base }) => {
			// one close-capture per upstream connection, in accept order
			const upstreamCloses: PromiseWithResolvers<
				{ code: number; reason: string }
			>[] = [];

			const upstream = await startTestServer((req, info) => {
				const captured = Promise.withResolvers<
					{ code: number; reason: string }
				>();
				upstreamCloses.push(captured);
				const { socket, response } = upgradeWebSocket(req, info);
				socket.onmessage = (e) => {
					if (e.data === "close-me") socket.close(4001, "bye-from-upstream");
				};
				socket.onclose = (e) =>
					captured.resolve({ code: e.code, reason: e.reason });
				return response;
			});

			try {
				app.get("/ws", proxy(`${upstream.base}/`));
				const wsUrl = base.replace(/^http/, "ws") + "/ws";

				// upstream-initiated close -> client sees code + reason
				const a = createWsClient(wsUrl);
				assert.ok(await a.opened, "tunnel should open");
				a.ws.send("close-me");
				const aClose = await a.closed;
				assert.equal(aClose.code, 4001);
				assert.equal(aClose.reason, "bye-from-upstream");
				await upstreamCloses[0].promise;

				// client-initiated close -> upstream sees code + reason
				const b = createWsClient(wsUrl);
				assert.ok(await b.opened, "tunnel should open");
				b.ws.close(4002, "bye-from-client");
				await b.closed;
				const bClose = await upstreamCloses[1].promise;
				assert.equal(bClose.code, 4002);
				assert.equal(bClose.reason, "bye-from-client");
			} finally {
				await upstream.close();
			}
		},
	},
	{
		name: "proxy websocket: policy failures surface as regular HTTP errors",
		fn: async ({ app, srv }) => {
			// held-open TCP listener: accepts but never answers -> handshake timeout
			const held: Socket[] = [];
			const silent = createServer((sock) => {
				held.push(sock);
				// a peer reset once the proxy gives up is not a failure of this test
				sock.on("error", () => {});
			});
			await new Promise<void>((resolve) => {
				silent.listen(0, "127.0.0.1", resolve);
			});
			const silentPort = (silent.address() as AddressInfo).port;

			try {
				// host allowlist rejection (pre-dial) -> 500 policy error
				app.get(
					"/ws-blocked",
					proxy("http://127.0.0.1:59999/", {
						allowedHosts: ["allowed.example.com"],
					}),
				);
				// SSRF rejection (pre-dial), custom onError takes over
				let ssrfError: Error | null = null;
				app.get(
					"/ws-ssrf",
					proxy("http://127.0.0.1:59999/", {
						preventSSRF: true,
						onError: (e) => {
							ssrfError = e;
							return new Response("blocked", { status: 403 });
						},
					}),
				);
				// unreachable upstream -> 502
				app.get("/ws-dead", proxy("http://127.0.0.1:1/"));
				// upstream that never completes the handshake -> 504
				app.get(
					"/ws-slow",
					proxy(`http://127.0.0.1:${silentPort}/`, { timeout: 100 }),
				);

				assert.match(
					await rawUpgradeRequest(srv.port, "/ws-blocked"),
					/^HTTP\/1\.1 500/,
				);
				assert.match(
					await rawUpgradeRequest(srv.port, "/ws-ssrf"),
					/^HTTP\/1\.1 403/,
				);
				assert.match(String(ssrfError), /SSRF/);
				assert.match(
					await rawUpgradeRequest(srv.port, "/ws-dead"),
					/^HTTP\/1\.1 502/,
				);
				assert.match(
					await rawUpgradeRequest(srv.port, "/ws-slow"),
					/^HTTP\/1\.1 504/,
				);
			} finally {
				held.forEach((s) => s.destroy());
				await new Promise<void>((resolve) => {
					silent.close(() => resolve());
				});
			}
		},
	},
	{
		name: "proxy websocket: webSockets:false falls through to the HTTP path",
		fn: async ({ app, srv }) => {
			const seen: { upgrade?: string | null } = {};
			const upstream = await startTestServer((req) => {
				seen.upgrade = req.headers.get("upgrade");
				return new Response("no-ws-here", { status: 426 });
			});

			try {
				app.get(
					"/ws-off",
					proxy(`${upstream.base}/`, { webSockets: false }),
				);
				const raw = await rawUpgradeRequest(srv.port, "/ws-off");
				// proxied as a plain GET (upgrade header stripped), upstream status relayed
				assert.match(raw, /^HTTP\/1\.1 426/);
				assert.equal(seen.upgrade, null);
			} finally {
				await upstream.close();
			}
		},
	},
	{
		name:
			"proxy websocket: no upgradeWebSocket capability -> HTTP fall-through, one warning",
		raw: true,
		fn: async () => {
			const upstreamSeen: (string | null)[] = [];
			const upstream = await startTestServer((req) => {
				upstreamSeen.push(req.headers.get("upgrade"));
				return new Response("no-ws-here", { status: 426 });
			});

			const warns: string[] = [];
			const logger: DeminoLogger = {
				debug() {},
				log() {},
				error() {},
				warn: (...a: unknown[]) => warns.push(a.map(String).join(" ")),
			};
			const app = demino("", [], { logger });
			// two proxy instances: the warning is per process, not per instance
			app.get("/ws-a", proxy(`${upstream.base}/`));
			app.get("/ws-b", proxy(`${upstream.base}/`));

			// A harness that omits `upgradeWebSocket` - what the app sees when it is
			// handed to the runtime's own server with no adapter in between.
			const srv = await startTestServer((req, info) =>
				app(req, { remoteAddr: info?.remoteAddr })
			);
			try {
				for (const path of ["/ws-a", "/ws-b", "/ws-a"]) {
					// proxied as a plain GET, upstream status relayed (= `webSockets: false`)
					assert.match(
						await rawUpgradeRequest(srv.port, path),
						/^HTTP\/1\.1 426/,
					);
				}
				// upgrade header stripped on every hop
				assert.deepEqual(upstreamSeen, [null, null, null]);

				const tunnelWarns = warns.filter((w) => /WebSocket tunneling/.test(w));
				assert.equal(
					tunnelWarns.length,
					1,
					`expected one warning, got: ${warns}`,
				);
				assert.match(tunnelWarns[0], /upgradeWebSocket/);
				assert.match(tunnelWarns[0], /plain HTTP/);
			} finally {
				await srv.close();
				await upstream.close();
			}
		},
	},
	{
		name: "proxy websocket: hop counter breaks proxy loops",
		fn: async ({ app, base, srv }) => {
			// two routes proxying to each other -> the hop counter (riding the
			// dial headers) must cut the recursion, surfacing as a gateway error
			app.get("/ws-loop-a", proxy(`${base}/ws-loop-b`));
			app.get("/ws-loop-b", proxy(`${base}/ws-loop-a`));
			assert.match(
				await rawUpgradeRequest(srv.port, "/ws-loop-a"),
				/^HTTP\/1\.1 502/,
			);
		},
	},
]);
