import { sleep } from "@marianmeres/midware";
import { serveFile } from "@std/http/file-server";
import { assertEquals } from "@std/assert";
import { proxy } from "../../middleware/proxy.ts";
import { assertResp, runTestServerTests } from "../_utils.ts";

runTestServerTests([
	{
		name: "proxy basic functionality",
		fn: async ({ app, base }) => {
			app.get("/a", () => "a");
			app.get("/b", (r) => new URL(r.url).search);
			app.get("/c", proxy("/d"));
			app.get("/d", () => "d");
			app.get("/file", (req) => serveFile(req, "./src/_tests/static/foo.txt"));

			app.get("/to-self", proxy("/to-self")); // will throw

			app.get("/xa", proxy("/a"));
			app.get("/xb", proxy("/b"));
			app.get("/xc", proxy("/c"));
			app.get("/xfile", proxy("/file"));

			await assertResp(fetch(`${base}/xa`), 200, "a");
			await assertResp(fetch(`${base}/xb?foo=bar`), 200, "?foo=bar");
			await assertResp(fetch(`${base}/xc`), 200, "d"); // not c!
			await assertResp(fetch(`${base}/to-self`), 500, /proxy to self/i);
			await assertResp(fetch(`${base}/xfile`), 200, "foo");

			//
			const _sleepTimer = { id: -1 };
			app.get("/slow", async () => {
				await sleep(100, _sleepTimer);
				return "woke up";
			});
			app.get("/xslow", proxy("/slow", { timeout: 20 }));
			await assertResp(fetch(`${base}/xslow`), 500, /timed out/i);
			clearTimeout(_sleepTimer.id);

			// target as full url
			app.get("/full", proxy(`${base}/d`));
			await assertResp(fetch(`${base}/full`), 200, "d");

			// relative target
			app.get("/a/b", () => "/a/b");
			app.get("/a/b/c/d", proxy("../"));
			await assertResp(fetch(`${base}/a/b/c/d`), 200, "/a/b");

			// wildcard proxy
			app.get(
				"/old/*",
				proxy((r) => {
					const path = new URL(r.url).pathname.slice("/old".length);
					return `/new${path}`;
				})
			);
			app.get("/new/*", (r) => new URL(r.url).pathname);

			await assertResp(fetch(`${base}/old`), 200, "/new");
			await assertResp(fetch(`${base}/old/`), 200, "/new/");
			await assertResp(fetch(`${base}/old/x/y/z`), 200, "/new/x/y/z");
		},
	},
	{
		name: "proxy SSRF protection",
		fn: async ({ app, base }) => {
			// SSRF protection blocks localhost
			app.get(
				"/ssrf-localhost",
				proxy("http://localhost:8080/", { preventSSRF: true })
			);
			await assertResp(
				fetch(`${base}/ssrf-localhost`),
				500,
				/SSRF protection.*localhost/i
			);

			// SSRF protection blocks 127.0.0.1
			app.get(
				"/ssrf-127",
				proxy("http://127.0.0.1:8080/", { preventSSRF: true })
			);
			await assertResp(
				fetch(`${base}/ssrf-127`),
				500,
				/SSRF protection.*127\.0\.0\.1/i
			);

			// SSRF protection blocks private IP ranges
			app.get(
				"/ssrf-private",
				proxy("http://192.168.1.1/", { preventSSRF: true })
			);
			await assertResp(
				fetch(`${base}/ssrf-private`),
				500,
				/SSRF protection.*192\.168\.1\.1/i
			);
		},
	},
	{
		name: "proxy host whitelist",
		fn: async ({ app, base }) => {
			app.get("/target", () => "allowed");

			// Only allow specific host
			const targetHost = new URL(base).hostname;
			app.get(
				"/whitelist-allowed",
				proxy(`${base}/target`, { allowedHosts: [targetHost] })
			);
			await assertResp(fetch(`${base}/whitelist-allowed`), 200, "allowed");

			// Block non-whitelisted host
			app.get(
				"/whitelist-blocked",
				proxy("https://example.com/", {
					allowedHosts: ["trusted.com", "*.safe.com"],
				})
			);
			await assertResp(
				fetch(`${base}/whitelist-blocked`),
				500,
				/not in the allowed hosts list/i
			);
		},
	},
	{
		name: "proxy custom headers",
		fn: async ({ app, base }) => {
			app.get("/echo-headers", (req) => {
				const apiKey = req.headers.get("x-api-key");
				const custom = req.headers.get("x-custom");
				return JSON.stringify({ apiKey, custom });
			});

			app.get(
				"/with-headers",
				proxy(`${base}/echo-headers`, {
					headers: {
						"x-api-key": "secret123",
						"x-custom": "value",
					},
				})
			);

			const resp = await fetch(`${base}/with-headers`);
			const data = await resp.json();
			assertEquals(data.apiKey, "secret123");
			assertEquals(data.custom, "value");
		},
	},
	{
		name: "proxy request header transformation",
		fn: async ({ app, base }) => {
			app.get("/echo-auth", (req) => {
				return req.headers.get("authorization") || "no-auth";
			});

			app.get(
				"/transform-headers",
				proxy(`${base}/echo-auth`, {
					transformRequestHeaders: (headers) => {
						headers.set("authorization", "Bearer TOKEN123");
						return headers;
					},
				})
			);

			await assertResp(
				fetch(`${base}/transform-headers`),
				200,
				"Bearer TOKEN123"
			);
		},
	},
	{
		name: "proxy response header transformation",
		fn: async ({ app, base }) => {
			app.get("/with-header", () => {
				return new Response("ok", {
					headers: { "x-original": "value" },
				});
			});

			app.get(
				"/transform-response-headers",
				proxy(`${base}/with-header`, {
					transformResponseHeaders: (headers) => {
						headers.set("x-transformed", "yes");
						headers.delete("x-original");
						return headers;
					},
				})
			);

			const resp = await fetch(`${base}/transform-response-headers`);
			assertEquals(resp.headers.get("x-transformed"), "yes");
			assertEquals(resp.headers.get("x-original"), null);
			await resp.text(); // Consume body to avoid leak
		},
	},
	{
		name: "proxy response body transformation",
		fn: async ({ app, base }) => {
			app.get("/json-data", () => ({ message: "hello" }));

			app.get(
				"/transform-body",
				proxy(`${base}/json-data`, {
					transformResponseBody: async (body) => {
						if (!body) return null;
						// Read the stream
						if (body instanceof ReadableStream) {
							const reader = body.getReader();
							const chunks: Uint8Array[] = [];
							while (true) {
								const { done, value } = await reader.read();
								if (done) break;
								chunks.push(value);
							}
							const text = new TextDecoder().decode(
								new Uint8Array(chunks.flatMap((c) => Array.from(c)))
							);
							const data = JSON.parse(text);
							return JSON.stringify({ ...data, transformed: true });
						}
						return body;
					},
				})
			);

			const resp = await fetch(`${base}/transform-body`);
			const data = await resp.json();
			assertEquals(data.message, "hello");
			assertEquals(data.transformed, true);
		},
	},
	{
		name: "proxy custom error handler",
		fn: async ({ app, base }) => {
			app.get(
				"/custom-error",
				proxy("http://nonexistent.invalid/", {
					timeout: 100, // Fast timeout to trigger error quickly
					onError: (error) => {
						return new Response(
							JSON.stringify({ error: "Custom error: " + error.message }),
							{
								status: 502,
								headers: { "content-type": "application/json" },
							}
						);
					},
				})
			);

			const resp = await fetch(`${base}/custom-error`);
			assertEquals(resp.status, 502);
			const data = await resp.json();
			assertEquals(data.error.startsWith("Custom error:"), true);
		},
		// only: true,
	},
	{
		name: "proxy configurable cache strategy",
		fn: async ({ app, base }) => {
			app.get("/cacheable", () => "cached-content");

			// Default cache strategy is "no-store"
			app.get("/no-cache", proxy(`${base}/cacheable`));

			// Custom cache strategy
			app.get("/with-cache", proxy(`${base}/cacheable`, { cache: "default" }));

			// Both should work (we can't easily test caching behavior in unit tests)
			await assertResp(fetch(`${base}/no-cache`), 200, "cached-content");
			await assertResp(fetch(`${base}/with-cache`), 200, "cached-content");
		},
	},
	{
		name: "proxy additional X-Forwarded headers",
		fn: async ({ app, base }) => {
			app.get("/echo-forwarded", (req) => {
				return JSON.stringify({
					host: req.headers.get("x-forwarded-host"),
					proto: req.headers.get("x-forwarded-proto"),
					port: req.headers.get("x-forwarded-port"),
					for: req.headers.get("x-forwarded-for"),
					realIp: req.headers.get("x-real-ip"),
				});
			});

			app.get("/check-forwarded", proxy(`${base}/echo-forwarded`));

			const resp = await fetch(`${base}/check-forwarded`);
			const data = await resp.json();
			assertEquals(typeof data.host, "string");
			assertEquals(typeof data.proto, "string");
			assertEquals(typeof data.port, "string");
			assertEquals(typeof data.for, "string");
			assertEquals(typeof data.realIp, "string");
		},
	},
	{
		name: "proxy custom header removal",
		fn: async ({ app, base }) => {
			app.get("/echo-all-headers", (req) => {
				const headers: Record<string, string> = {};
				req.headers.forEach((value, key) => {
					headers[key] = value;
				});
				return JSON.stringify(headers);
			});

			app.get(
				"/remove-headers",
				proxy(`${base}/echo-all-headers`, {
					removeRequestHeaders: ["user-agent"],
				})
			);

			const resp = await fetch(`${base}/remove-headers`, {
				headers: { "user-agent": "custom-agent" },
			});
			const data = await resp.json();
			// user-agent should be removed - the fetch API may add a default user-agent
			// so we just verify it's not our custom one
			assertEquals(data["user-agent"] !== "custom-agent", true);
		},
	},
]);
