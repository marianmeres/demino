import { assert, assertEquals, assertMatch } from "@std/assert";
import { proxy } from "../../src/middleware/proxy/proxy.ts";
import { assertResp, runTestServerTests, startTestServer } from "../_utils.ts";

/** Test WS client with awaitable open/close and a message inbox. */
function createWsClient(
	url: string,
	options?: { protocols?: string[]; headers?: HeadersInit },
) {
	// the options bag (protocols + headers) is a Deno extension
	const ws = new WebSocket(url, options ?? {});
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

/** Sends a raw (fake) upgrade request and returns the beginning of the raw response. */
async function rawUpgradeRequest(port: number, path: string): Promise<string> {
	const conn = await Deno.connect({ hostname: "127.0.0.1", port });
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
	await conn.write(new TextEncoder().encode(head));
	const buf = new Uint8Array(8192);
	const n = (await conn.read(buf)) ?? 0;
	conn.close();
	return new TextDecoder().decode(buf.subarray(0, n));
}

runTestServerTests([
	{
		name: "proxy websocket: tunnels messages, headers and subprotocol",
		fn: async ({ app, base }) => {
			const seen: { url?: string; headers?: Headers } = {};
			const upstreamSocketClosed = Promise.withResolvers<void>();

			const upstream = await startTestServer((req) => {
				seen.url = req.url;
				// snapshot: the live req.headers becomes unreadable once the request closes
				seen.headers = new Headers(req.headers);
				// non-upgrade requests keep working over the regular HTTP proxy path
				if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
					return new Response("plain-http");
				}
				const { socket, response } = Deno.upgradeWebSocket(req, {
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

				assert(await opened, "tunnel should open");

				// upstream-negotiated subprotocol is mirrored back to the client
				assertEquals(ws.protocol, "chat.v2");

				// text roundtrip
				ws.send("hello");
				assertEquals(await nextMessage(), "echo:hello");

				// binary roundtrip
				ws.send(new Uint8Array([1, 2, 3]));
				const bin = await nextMessage();
				assert(bin instanceof ArrayBuffer);
				assertEquals([...new Uint8Array(bin)], [1, 2, 3]);

				// path + query forwarded (wildcard target)
				const upstreamUrl = new URL(seen.url!);
				assertEquals(upstreamUrl.pathname, "/ws/room");
				assertEquals(upstreamUrl.search, "?x=1");

				// headers forwarded: cookies, custom injected, loop guard, x-forwarded-*
				assertEquals(seen.headers!.get("cookie"), "session=abc");
				assertEquals(seen.headers!.get("x-injected"), "yes");
				assertEquals(seen.headers!.get("x-demino-proxy-hops"), "1");
				assertEquals(seen.headers!.get("x-forwarded-proto"), "http");
				assertEquals(seen.headers!.get("x-forwarded-host"), new URL(base).host);
				// offered subprotocols reached the upstream via the dial, not raw header copy
				assertMatch(seen.headers!.get("sec-websocket-protocol")!, /chat\.v2/);

				ws.close();
				await closed;
				await upstreamSocketClosed.promise;

				// the same route still serves plain HTTP requests
				await assertResp(fetch(`${base}/ws/plain`), 200, "plain-http");
			} finally {
				upstream.ac.abort();
				await upstream.server.finished;
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

			const upstream = await startTestServer((req) => {
				const captured = Promise.withResolvers<
					{ code: number; reason: string }
				>();
				upstreamCloses.push(captured);
				const { socket, response } = Deno.upgradeWebSocket(req);
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
				assert(await a.opened, "tunnel should open");
				a.ws.send("close-me");
				const aClose = await a.closed;
				assertEquals(aClose.code, 4001);
				assertEquals(aClose.reason, "bye-from-upstream");
				await upstreamCloses[0].promise;

				// client-initiated close -> upstream sees code + reason
				const b = createWsClient(wsUrl);
				assert(await b.opened, "tunnel should open");
				b.ws.close(4002, "bye-from-client");
				await b.closed;
				const bClose = await upstreamCloses[1].promise;
				assertEquals(bClose.code, 4002);
				assertEquals(bClose.reason, "bye-from-client");
			} finally {
				upstream.ac.abort();
				await upstream.server.finished;
			}
		},
	},
	{
		name: "proxy websocket: policy failures surface as regular HTTP errors",
		fn: async ({ app, srv }) => {
			// held-open TCP listener: accepts but never answers -> handshake timeout
			const silent = Deno.listen({ hostname: "127.0.0.1", port: 0 });
			const silentPort = (silent.addr as Deno.NetAddr).port;
			const held: Deno.Conn[] = [];
			const acceptLoop = (async () => {
				try {
					for await (const conn of silent) held.push(conn);
				} catch {
					/* listener closed */
				}
			})();

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

				assertMatch(
					await rawUpgradeRequest(srv.port, "/ws-blocked"),
					/^HTTP\/1\.1 500/,
				);
				assertMatch(
					await rawUpgradeRequest(srv.port, "/ws-ssrf"),
					/^HTTP\/1\.1 403/,
				);
				assertMatch(String(ssrfError), /SSRF/);
				assertMatch(
					await rawUpgradeRequest(srv.port, "/ws-dead"),
					/^HTTP\/1\.1 502/,
				);
				assertMatch(
					await rawUpgradeRequest(srv.port, "/ws-slow"),
					/^HTTP\/1\.1 504/,
				);
			} finally {
				silent.close();
				held.forEach((c) => {
					try {
						c.close();
					} catch {
						/* ignore */
					}
				});
				await acceptLoop;
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
				assertMatch(raw, /^HTTP\/1\.1 426/);
				assertEquals(seen.upgrade, null);
			} finally {
				upstream.ac.abort();
				await upstream.server.finished;
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
			assertMatch(
				await rawUpgradeRequest(srv.port, "/ws-loop-a"),
				/^HTTP\/1\.1 502/,
			);
		},
	},
]);
