import { assert, assertEquals } from "@std/assert";
import { proxy } from "../../src/middleware/proxy/proxy.ts";
import { assertResp, runTestServerTests } from "../_utils.ts";

// A 302 Location pointing at a host the proxy is NOT allowed to reach must NOT be
// followed — fetch's own `redirect: "follow"` would skip the per-hop SSRF/allowlist
// re-check and reach the internal resource.
runTestServerTests([
	{
		name: "proxy: hop counter is forwarded and a loop (too many hops) is rejected",
		fn: async ({ app, base }) => {
			// upstream echoes back the hop counter it received
			app.get("/echo", (r) => r.headers.get("x-demino-proxy-hops") ?? "none");
			app.get("/p", proxy(`${base}/echo`, { allowedHosts: ["localhost"] }));

			// a normal request forwards an incremented hop counter (0 -> 1)
			await assertResp(fetch(`${base}/p`), 200, "1");

			// a request that already reached the hop limit is treated as a loop -> 500
			const looped = await fetch(`${base}/p`, {
				headers: { "x-demino-proxy-hops": "32" },
			});
			await looped.text();
			assertEquals(looped.status, 500);
		},
	},
	{
		name: "proxy re-validates redirect hops (SSRF via redirect is blocked)",
		fn: async ({ app, base }) => {
			// `localhost` and `127.0.0.1` are the same server but DIFFERENT hostnames,
			// so the allowlist can permit one and block the other.
			const internal = base.replace("localhost", "127.0.0.1");

			app.get("/secret", () => "SECRET"); // stands in for an internal-only resource
			app.get(
				"/redir-evil",
				() =>
					new Response(null, {
						status: 302,
						headers: { location: `${internal}/secret` },
					}),
			);

			// initial target (localhost) is allowed; the redirect target (127.0.0.1)
			// is not -> the hop must be rejected, never fetched.
			app.get(
				"/x-evil",
				proxy(`${base}/redir-evil`, { allowedHosts: ["localhost"] }),
			);

			const r = await fetch(`${base}/x-evil`);
			const text = await r.text();
			assertEquals(r.status, 500);
			assert(!text.includes("SECRET"), "internal resource must not be reachable");
		},
	},
	{
		name: "proxy follows a redirect to an allowed host",
		fn: async ({ app, base }) => {
			app.get("/secret2", () => "OK-SECRET");
			app.get(
				"/redir-ok",
				() =>
					new Response(null, {
						status: 302,
						headers: { location: `${base}/secret2` }, // same (allowed) host
					}),
			);
			app.get(
				"/x-ok",
				proxy(`${base}/redir-ok`, { allowedHosts: ["localhost"] }),
			);

			// legitimate same-host redirect is still followed transparently
			await assertResp(fetch(`${base}/x-ok`), 200, "OK-SECRET");
		},
	},
	{
		name: "proxy enforces the redirect limit",
		fn: async ({ app, base }) => {
			app.get(
				"/loop",
				() =>
					new Response(null, {
						status: 302,
						headers: { location: `${base}/loop` }, // allowed host, infinite loop
					}),
			);
			app.get(
				"/x-loop",
				proxy(`${base}/loop`, { allowedHosts: ["localhost"], maxRedirects: 2 }),
			);

			// capped instead of looping forever
			await assertResp(fetch(`${base}/x-loop`), 500);
		},
	},
]);
