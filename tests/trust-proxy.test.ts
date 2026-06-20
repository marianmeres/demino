import type { Demino } from "../src/demino.ts";
import { redirect } from "../src/middleware/redirect.ts";
import { assertResp, runTestServerTests } from "./_utils.ts";

// A handler that simply echoes the effective `ctx.url`, so the test can assert how
// `trustProxy` rewrites scheme/host/port from the X-Forwarded-* headers. The test
// server binds `http://localhost:<port>`, so without trust everything stays `http`.
const echoUrl = "/u";
function mount(app: Demino) {
	app.get(echoUrl, (_req, _info, ctx) => ctx.url.href);
}

runTestServerTests([
	{
		// Default (no trustProxy): forwarded headers must have ZERO effect —
		// ctx.url === new URL(req.url). Back-compat guarantee.
		name: "trustProxy off: X-Forwarded-* are ignored",
		fn: async ({ app, base }) => {
			mount(app);
			await assertResp(
				fetch(`${base}${echoUrl}`, {
					headers: {
						"x-forwarded-proto": "https",
						"x-forwarded-host": "evil.com",
						"x-forwarded-port": "443",
					},
				}),
				200,
				/^http:\/\/localhost:\d+\/u$/,
			);
		},
	},
	{
		// trustProxy: true => trust X-Forwarded-Proto only. Host is NOT reflected.
		name: "trustProxy true: honors X-Forwarded-Proto, ignores forwarded host",
		appOptions: { trustProxy: true },
		fn: async ({ app, base }) => {
			mount(app);
			// proto honored (http -> https); host stays the request host
			await assertResp(
				fetch(`${base}${echoUrl}`, {
					headers: {
						"x-forwarded-proto": "https",
						"x-forwarded-host": "evil.com",
					},
				}),
				200,
				/^https:\/\/localhost:\d+\/u$/,
			);
		},
	},
	{
		name: "trustProxy true: comma list uses the left-most (immediate-hop) proto",
		appOptions: { trustProxy: true },
		fn: async ({ app, base }) => {
			mount(app);
			await assertResp(
				fetch(`${base}${echoUrl}`, {
					headers: { "x-forwarded-proto": "https, http" },
				}),
				200,
				/^https:\/\/localhost:\d+\/u$/,
			);
		},
	},
	{
		name: "trustProxy true: a bogus X-Forwarded-Proto is ignored",
		appOptions: { trustProxy: true },
		fn: async ({ app, base }) => {
			mount(app);
			await assertResp(
				fetch(`${base}${echoUrl}`, {
					headers: { "x-forwarded-proto": "javascript" },
				}),
				200,
				/^http:\/\/localhost:\d+\/u$/,
			);
		},
	},
	{
		// allowlist match: host adopted AND the internal origin port must NOT leak.
		name:
			"trustProxy allowedHosts: adopts a matching host without leaking the origin port",
		appOptions: {
			trustProxy: { allowedHosts: ["example.com", "*.example.com"] },
		},
		fn: async ({ app, base }) => {
			mount(app);
			// exact match -> https://example.com/u  (no :<port>)
			await assertResp(
				fetch(`${base}${echoUrl}`, {
					headers: {
						"x-forwarded-proto": "https",
						"x-forwarded-host": "example.com",
					},
				}),
				200,
				/^https:\/\/example\.com\/u$/,
			);
			// wildcard subdomain match
			await assertResp(
				fetch(`${base}${echoUrl}`, {
					headers: {
						"x-forwarded-proto": "https",
						"x-forwarded-host": "www.example.com",
					},
				}),
				200,
				/^https:\/\/www\.example\.com\/u$/,
			);
		},
	},
	{
		// allowlist MISS: forged host dropped, request host kept.
		name: "trustProxy allowedHosts: drops a non-matching forwarded host",
		appOptions: { trustProxy: { allowedHosts: ["example.com"] } },
		fn: async ({ app, base }) => {
			mount(app);
			await assertResp(
				fetch(`${base}${echoUrl}`, {
					headers: {
						"x-forwarded-proto": "https",
						"x-forwarded-host": "evil.com",
					},
				}),
				200,
				/^https:\/\/localhost:\d+\/u$/,
			);
		},
	},
	{
		// empty allowlist trusts NO forwarded host (proto only).
		name: "trustProxy empty allowedHosts: host never reflected, proto still honored",
		appOptions: { trustProxy: { allowedHosts: [] } },
		fn: async ({ app, base }) => {
			mount(app);
			await assertResp(
				fetch(`${base}${echoUrl}`, {
					headers: {
						"x-forwarded-proto": "https",
						"x-forwarded-host": "example.com",
					},
				}),
				200,
				/^https:\/\/localhost:\d+\/u$/,
			);
		},
	},
	{
		name: "trustProxy allowedHosts: X-Forwarded-Port is applied for the public port",
		appOptions: { trustProxy: { allowedHosts: ["example.com"] } },
		fn: async ({ app, base }) => {
			mount(app);
			await assertResp(
				fetch(`${base}${echoUrl}`, {
					headers: {
						"x-forwarded-proto": "https",
						"x-forwarded-host": "example.com",
						"x-forwarded-port": "8443",
					},
				}),
				200,
				/^https:\/\/example\.com:8443\/u$/,
			);
		},
	},
	{
		name: "trustProxy allowedHosts: an explicit port inside X-Forwarded-Host wins",
		appOptions: { trustProxy: { allowedHosts: ["example.com"] } },
		fn: async ({ app, base }) => {
			mount(app);
			await assertResp(
				fetch(`${base}${echoUrl}`, {
					headers: {
						"x-forwarded-proto": "https",
						"x-forwarded-host": "example.com:9000",
						"x-forwarded-port": "8443",
					},
				}),
				200,
				/^https:\/\/example\.com:9000\/u$/,
			);
		},
	},
	{
		// SECURITY (allowlist-bypass regression): host-terminator chars must NOT
		// smuggle a foreign host past the allowlist. `evil.com#.example.com` ends with
		// ".example.com" as a raw string but its real host is `evil.com`. Every variant
		// must be DROPPED back to the request host (localhost), never reflected.
		name: "trustProxy allowedHosts: host-terminator smuggling is rejected",
		appOptions: { trustProxy: { allowedHosts: ["example.com", "*.example.com"] } },
		fn: async ({ app, base }) => {
			mount(app);
			const localhost = /^https:\/\/localhost:\d+\/u$/;
			for (
				const forged of [
					"evil.com#.example.com",
					"evil.com/.example.com",
					"evil.com?.example.com",
					"evil.com\\.example.com",
					"evil.com@good.example.com",
					"evil.com:80#.example.com",
				]
			) {
				await assertResp(
					fetch(`${base}${echoUrl}`, {
						headers: {
							"x-forwarded-proto": "https",
							"x-forwarded-host": forged,
						},
					}),
					200,
					localhost,
				);
			}
		},
	},
	{
		// SECURITY: a mixed-case forwarded host must still match a lowercase allowlist
		// (hostnames are case-insensitive). Previously this failed closed (dropped to
		// the internal origin) — now it is adopted, normalized to lowercase.
		name:
			"trustProxy allowedHosts: mixed-case forwarded host matches and is lowercased",
		appOptions: { trustProxy: { allowedHosts: ["example.com"] } },
		fn: async ({ app, base }) => {
			mount(app);
			await assertResp(
				fetch(`${base}${echoUrl}`, {
					headers: {
						"x-forwarded-proto": "https",
						"x-forwarded-host": "EXAMPLE.com",
					},
				}),
				200,
				/^https:\/\/example\.com\/u$/,
			);
		},
	},
	{
		// Empty-label hosts (leading/double dot) are not real hostnames -> rejected.
		name: "trustProxy allowedHosts: empty-label forwarded host is rejected",
		appOptions: { trustProxy: { allowedHosts: ["example.com", "*.example.com"] } },
		fn: async ({ app, base }) => {
			mount(app);
			const localhost = /^https:\/\/localhost:\d+\/u$/;
			for (const forged of [".example.com", "..example.com", "a..example.com"]) {
				await assertResp(
					fetch(`${base}${echoUrl}`, {
						headers: {
							"x-forwarded-proto": "https",
							"x-forwarded-host": forged,
						},
					}),
					200,
					localhost,
				);
			}
		},
	},
	{
		// PORT range regression: a numeric-but-out-of-range / zero forwarded port must
		// never leak the internal origin port (the URL setter silently no-ops on
		// >65535) nor emit a bogus :0 — it must clear to the protocol default.
		name: "trustProxy allowedHosts: out-of-range / zero forwarded port is ignored",
		appOptions: { trustProxy: { allowedHosts: ["example.com"] } },
		fn: async ({ app, base }) => {
			mount(app);
			const clean = /^https:\/\/example\.com\/u$/;
			// X-Forwarded-Port out of range / zero -> cleared
			for (const p of ["99999", "65536", "0"]) {
				await assertResp(
					fetch(`${base}${echoUrl}`, {
						headers: {
							"x-forwarded-proto": "https",
							"x-forwarded-host": "example.com",
							"x-forwarded-port": p,
						},
					}),
					200,
					clean,
				);
			}
			// explicit out-of-range port INSIDE X-Forwarded-Host -> whole host rejected
			await assertResp(
				fetch(`${base}${echoUrl}`, {
					headers: {
						"x-forwarded-proto": "https",
						"x-forwarded-host": "example.com:99999",
					},
				}),
				200,
				/^https:\/\/localhost:\d+\/u$/,
			);
		},
	},
	{
		// ctx.ip is gated by the SAME flag: off => forwarded headers ignored, the
		// direct socket peer (127.0.0.1 in tests) is used. A forged XFF has no effect.
		name: "ctx.ip ignores X-Forwarded-For when trustProxy is off",
		fn: async ({ app, base }) => {
			app.get("/ip", (_req, _info, ctx) => ctx.ip);
			await assertResp(
				fetch(`${base}/ip`, {
					headers: { "x-forwarded-for": "9.9.9.9" },
				}),
				200,
				/^127\.0\.0\.1$/,
			);
		},
	},
	{
		name: "ctx.ip honors the left-most X-Forwarded-For when trustProxy is on",
		appOptions: { trustProxy: true },
		fn: async ({ app, base }) => {
			app.get("/ip", (_req, _info, ctx) => ctx.ip);
			// single value
			await assertResp(
				fetch(`${base}/ip`, {
					headers: { "x-forwarded-for": "9.9.9.9" },
				}),
				200,
				"9.9.9.9",
			);
			// comma list -> left-most (original client)
			await assertResp(
				fetch(`${base}/ip`, {
					headers: { "x-forwarded-for": "9.9.9.9, 10.0.0.1" },
				}),
				200,
				"9.9.9.9",
			);
		},
	},
	{
		name: "ctx.ip falls back to the socket peer when trustProxy on but no header",
		appOptions: { trustProxy: true },
		fn: async ({ app, base }) => {
			app.get("/ip", (_req, _info, ctx) => ctx.ip);
			await assertResp(fetch(`${base}/ip`), 200, /^127\.0\.0\.1$/);
		},
	},
	{
		// End-to-end: redirect() under trustProxy stays RELATIVE for same-origin,
		// so the proxy scheme is irrelevant and never emitted.
		name: "redirect under trustProxy stays relative for same-origin",
		appOptions: { trustProxy: { allowedHosts: ["example.com"] } },
		fn: async ({ app, base }) => {
			app.get("/old", redirect("/new", 301));
			await assertResp(
				fetch(`${base}/old`, {
					redirect: "manual",
					headers: {
						"x-forwarded-proto": "https",
						"x-forwarded-host": "example.com",
					},
				}),
				301,
				"",
				{ location: /^\/new$/ },
			);
		},
	},
]);
