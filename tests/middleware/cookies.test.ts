import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCookies, serializeCookie } from "../../src/utils/cookies.ts";
import { cookies, type CookiesLocals } from "../../src/middleware/cookies.ts";
import { assertResp, runTestServerTests } from "../_utils.ts";

test("serializeCookie - rejects illegal path/domain (attribute / CRLF injection)", () => {
	// CRLF would forge a second Set-Cookie header
	assert.throws(
		() => serializeCookie("s", "v", { path: "/x\r\nSet-Cookie: admin=1" }),
		{ name: "TypeError", message: /path/ },
	);
	// ";" would inject extra cookie attributes
	assert.throws(
		() => serializeCookie("s", "v", { path: "/x; HttpOnly" }),
		TypeError,
	);
	assert.throws(
		() => serializeCookie("s", "v", { domain: "e.com\r\nX-Evil: y" }),
		{ name: "TypeError", message: /domain/ },
	);
	// legitimate values are unaffected
	assert.equal(
		serializeCookie("s", "v", { path: "/", domain: "example.com" }),
		"s=v; Path=/; Domain=example.com",
	);
});

// Unit tests for utility functions
test("parseCookies - empty/null input", () => {
	assert.deepEqual(parseCookies(null), {});
	assert.deepEqual(parseCookies(""), {});
});

test("parseCookies - single cookie", () => {
	assert.deepEqual(parseCookies("foo=bar"), { foo: "bar" });
});

test("parseCookies - multiple cookies", () => {
	assert.deepEqual(parseCookies("foo=bar; baz=qux"), { foo: "bar", baz: "qux" });
});

test("parseCookies - cookies with spaces", () => {
	assert.deepEqual(parseCookies("  foo=bar  ;  baz=qux  "), {
		foo: "bar",
		baz: "qux",
	});
});

test("parseCookies - URL encoded values", () => {
	assert.deepEqual(parseCookies("name=hello%20world"), { name: "hello world" });
});

test("parseCookies - value with equals sign", () => {
	assert.deepEqual(parseCookies("data=a=b=c"), { data: "a=b=c" });
});

test("serializeCookie - basic", () => {
	assert.equal(serializeCookie("foo", "bar"), "foo=bar");
});

test("serializeCookie - URL encodes name and value", () => {
	assert.equal(serializeCookie("hello world", "a=b"), "hello%20world=a%3Db");
});

test("serializeCookie - with maxAge", () => {
	assert.equal(
		serializeCookie("foo", "bar", { maxAge: 3600 }),
		"foo=bar; Max-Age=3600",
	);
});

test("serializeCookie - with path", () => {
	assert.equal(serializeCookie("foo", "bar", { path: "/" }), "foo=bar; Path=/");
});

test("serializeCookie - with domain", () => {
	assert.equal(
		serializeCookie("foo", "bar", { domain: "example.com" }),
		"foo=bar; Domain=example.com",
	);
});

test("serializeCookie - with secure", () => {
	assert.equal(
		serializeCookie("foo", "bar", { secure: true }),
		"foo=bar; Secure",
	);
});

test("serializeCookie - with httpOnly", () => {
	assert.equal(
		serializeCookie("foo", "bar", { httpOnly: true }),
		"foo=bar; HttpOnly",
	);
});

test("serializeCookie - with sameSite", () => {
	assert.equal(
		serializeCookie("foo", "bar", { sameSite: "Strict" }),
		"foo=bar; SameSite=Strict",
	);
	assert.equal(
		serializeCookie("foo", "bar", { sameSite: "Lax" }),
		"foo=bar; SameSite=Lax",
	);
	assert.equal(
		serializeCookie("foo", "bar", { sameSite: "None" }),
		"foo=bar; SameSite=None",
	);
});

test("serializeCookie - with expires", () => {
	const date = new Date("2025-12-31T23:59:59Z");
	assert.equal(
		serializeCookie("foo", "bar", { expires: date }),
		"foo=bar; Expires=Wed, 31 Dec 2025 23:59:59 GMT",
	);
});

test("serializeCookie - with all options", () => {
	const date = new Date("2025-12-31T23:59:59Z");
	const result = serializeCookie("session", "abc123", {
		maxAge: 3600,
		expires: date,
		path: "/",
		domain: "example.com",
		secure: true,
		httpOnly: true,
		sameSite: "Lax",
	});
	assert.equal(
		result,
		"session=abc123; Max-Age=3600; Expires=Wed, 31 Dec 2025 23:59:59 GMT; Path=/; Domain=example.com; Secure; HttpOnly; SameSite=Lax",
	);
});

// Integration tests with middleware
runTestServerTests([
	{
		name: "cookies middleware - parses request cookies",
		fn: async ({ app, base }) => {
			app.use(cookies());
			app.get("/", (_req, _info, ctx) => {
				return ctx.locals.cookies;
			});

			await assertResp(
				fetch(`${base}/`, { headers: { cookie: "foo=bar; baz=qux" } }),
				200,
				{ foo: "bar", baz: "qux" },
			);
		},
	},
	{
		name: "cookies middleware - setCookie sets response header",
		fn: async ({ app, base }) => {
			app.use(cookies());
			app.get("/", (_req, _info, ctx) => {
				(ctx.locals as unknown as CookiesLocals).setCookie("session", "abc123", {
					httpOnly: true,
					path: "/",
				});
				return { ok: true };
			});

			await assertResp(
				fetch(`${base}/`),
				200,
				{ ok: true },
				{
					"set-cookie": "session=abc123; Path=/; HttpOnly",
				},
			);
		},
	},
	{
		name: "cookies middleware - multiple setCookie calls",
		fn: async ({ app, base }) => {
			app.use(cookies());
			app.get("/", (_req, _info, ctx) => {
				(ctx.locals as unknown as CookiesLocals).setCookie("a", "1");
				(ctx.locals as unknown as CookiesLocals).setCookie("b", "2");
				return { ok: true };
			});

			const resp = await fetch(`${base}/`);
			assert.equal(resp.status, 200);
			// Headers.getSetCookie() returns all Set-Cookie values
			const setCookies = resp.headers.getSetCookie();
			assert.equal(setCookies.length, 2);
			assert.equal(setCookies[0], "a=1");
			assert.equal(setCookies[1], "b=2");
			// Consume body to avoid leak
			await resp.text();
		},
	},
	{
		name: "cookies middleware - deleteCookie sets maxAge=0",
		fn: async ({ app, base }) => {
			app.use(cookies());
			app.post("/logout", (_req, _info, ctx) => {
				(ctx.locals as unknown as CookiesLocals).deleteCookie("session", {
					path: "/",
				});
				return { loggedOut: true };
			});

			await assertResp(
				fetch(`${base}/logout`, { method: "POST" }),
				200,
				{ loggedOut: true },
				{ "set-cookie": "session=; Max-Age=0; Path=/" },
			);
		},
	},
	{
		name: "cookies middleware - works with empty cookie header",
		fn: async ({ app, base }) => {
			app.use(cookies());
			app.get("/", (_req, _info, ctx) => {
				return {
					count: Object.keys((ctx.locals as unknown as CookiesLocals).cookies)
						.length,
				};
			});

			await assertResp(fetch(`${base}/`), 200, { count: 0 });
		},
	},
	{
		name: "cookies middleware - defaults are applied to setCookie",
		fn: async ({ app, base }) => {
			app.use(cookies({ httpOnly: true, secure: true, path: "/" }));
			app.get("/", (_req, _info, ctx) => {
				(ctx.locals as unknown as CookiesLocals).setCookie("session", "abc123");
				return { ok: true };
			});

			await assertResp(fetch(`${base}/`), 200, { ok: true }, {
				"set-cookie": "session=abc123; Path=/; Secure; HttpOnly",
			});
		},
	},
	{
		name: "cookies middleware - per-call options override defaults",
		fn: async ({ app, base }) => {
			app.use(cookies({ httpOnly: true, secure: true, path: "/" }));
			app.get("/", (_req, _info, ctx) => {
				// Override httpOnly and add maxAge
				(ctx.locals as unknown as CookiesLocals).setCookie("theme", "dark", {
					httpOnly: false,
					maxAge: 86400,
				});
				return { ok: true };
			});

			await assertResp(fetch(`${base}/`), 200, { ok: true }, {
				// httpOnly should be false (not present), secure and path from defaults
				"set-cookie": "theme=dark; Max-Age=86400; Path=/; Secure",
			});
		},
	},
	{
		name: "cookies middleware - deleteCookie uses path/domain from defaults",
		fn: async ({ app, base }) => {
			app.use(cookies({ path: "/", domain: "example.com" }));
			app.post("/logout", (_req, _info, ctx) => {
				(ctx.locals as unknown as CookiesLocals).deleteCookie("session");
				return { loggedOut: true };
			});

			await assertResp(
				fetch(`${base}/logout`, { method: "POST" }),
				200,
				{ loggedOut: true },
				{ "set-cookie": "session=; Max-Age=0; Path=/; Domain=example.com" },
			);
		},
	},
]);
