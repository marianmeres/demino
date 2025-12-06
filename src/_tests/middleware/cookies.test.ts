import { assertEquals } from "@std/assert";
import { parseCookies, serializeCookie } from "../../utils/cookies.ts";
import { cookies, type CookiesLocals } from "../../middleware/cookies.ts";
import { assertResp, runTestServerTests } from "../_utils.ts";

// Unit tests for utility functions
Deno.test("parseCookies - empty/null input", () => {
	assertEquals(parseCookies(null), {});
	assertEquals(parseCookies(""), {});
});

Deno.test("parseCookies - single cookie", () => {
	assertEquals(parseCookies("foo=bar"), { foo: "bar" });
});

Deno.test("parseCookies - multiple cookies", () => {
	assertEquals(parseCookies("foo=bar; baz=qux"), { foo: "bar", baz: "qux" });
});

Deno.test("parseCookies - cookies with spaces", () => {
	assertEquals(parseCookies("  foo=bar  ;  baz=qux  "), {
		foo: "bar",
		baz: "qux",
	});
});

Deno.test("parseCookies - URL encoded values", () => {
	assertEquals(parseCookies("name=hello%20world"), { name: "hello world" });
});

Deno.test("parseCookies - value with equals sign", () => {
	assertEquals(parseCookies("data=a=b=c"), { data: "a=b=c" });
});

Deno.test("serializeCookie - basic", () => {
	assertEquals(serializeCookie("foo", "bar"), "foo=bar");
});

Deno.test("serializeCookie - URL encodes name and value", () => {
	assertEquals(serializeCookie("hello world", "a=b"), "hello%20world=a%3Db");
});

Deno.test("serializeCookie - with maxAge", () => {
	assertEquals(
		serializeCookie("foo", "bar", { maxAge: 3600 }),
		"foo=bar; Max-Age=3600"
	);
});

Deno.test("serializeCookie - with path", () => {
	assertEquals(serializeCookie("foo", "bar", { path: "/" }), "foo=bar; Path=/");
});

Deno.test("serializeCookie - with domain", () => {
	assertEquals(
		serializeCookie("foo", "bar", { domain: "example.com" }),
		"foo=bar; Domain=example.com"
	);
});

Deno.test("serializeCookie - with secure", () => {
	assertEquals(
		serializeCookie("foo", "bar", { secure: true }),
		"foo=bar; Secure"
	);
});

Deno.test("serializeCookie - with httpOnly", () => {
	assertEquals(
		serializeCookie("foo", "bar", { httpOnly: true }),
		"foo=bar; HttpOnly"
	);
});

Deno.test("serializeCookie - with sameSite", () => {
	assertEquals(
		serializeCookie("foo", "bar", { sameSite: "Strict" }),
		"foo=bar; SameSite=Strict"
	);
	assertEquals(
		serializeCookie("foo", "bar", { sameSite: "Lax" }),
		"foo=bar; SameSite=Lax"
	);
	assertEquals(
		serializeCookie("foo", "bar", { sameSite: "None" }),
		"foo=bar; SameSite=None"
	);
});

Deno.test("serializeCookie - with expires", () => {
	const date = new Date("2025-12-31T23:59:59Z");
	assertEquals(
		serializeCookie("foo", "bar", { expires: date }),
		"foo=bar; Expires=Wed, 31 Dec 2025 23:59:59 GMT"
	);
});

Deno.test("serializeCookie - with all options", () => {
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
	assertEquals(
		result,
		"session=abc123; Max-Age=3600; Expires=Wed, 31 Dec 2025 23:59:59 GMT; Path=/; Domain=example.com; Secure; HttpOnly; SameSite=Lax"
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
				{ foo: "bar", baz: "qux" }
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
				}
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
			assertEquals(resp.status, 200);
			// Headers.getSetCookie() returns all Set-Cookie values
			const setCookies = resp.headers.getSetCookie();
			assertEquals(setCookies.length, 2);
			assertEquals(setCookies[0], "a=1");
			assertEquals(setCookies[1], "b=2");
			// Consume body to avoid leak
			await resp.text();
		},
	},
	{
		name: "cookies middleware - deleteCookie sets maxAge=0",
		fn: async ({ app, base }) => {
			app.use(cookies());
			app.post("/logout", (_req, _info, ctx) => {
				(ctx.locals as unknown as CookiesLocals).deleteCookie("session", { path: "/" });
				return { loggedOut: true };
			});

			await assertResp(
				fetch(`${base}/logout`, { method: "POST" }),
				200,
				{ loggedOut: true },
				{ "set-cookie": "session=; Max-Age=0; Path=/" }
			);
		},
	},
	{
		name: "cookies middleware - works with empty cookie header",
		fn: async ({ app, base }) => {
			app.use(cookies());
			app.get("/", (_req, _info, ctx) => {
				return { count: Object.keys((ctx.locals as unknown as CookiesLocals).cookies).length };
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
				(ctx.locals as unknown as CookiesLocals).setCookie("theme", "dark", { httpOnly: false, maxAge: 86400 });
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
