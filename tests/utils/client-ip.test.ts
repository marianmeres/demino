import { assertEquals } from "@std/assert";
import { getClientIpFromHeaders } from "../../src/utils/client-ip.ts";

const h = (init: Record<string, string>) => new Headers(init);

/** Mirrors the module's precedence (request-ip 3.3.0, headers only). */
const ORDER = [
	"x-client-ip",
	"x-forwarded-for",
	"cf-connecting-ip",
	"fastly-client-ip",
	"true-client-ip",
	"x-real-ip",
	"x-cluster-client-ip",
	"x-forwarded",
	"forwarded-for",
	"x-appengine-user-ip",
	"cf-pseudo-ipv4",
];

Deno.test("client-ip: each supported header alone resolves", () => {
	for (const name of ORDER) {
		assertEquals(getClientIpFromHeaders(h({ [name]: "9.9.9.9" })), "9.9.9.9", name);
	}
});

Deno.test("client-ip: precedence — removing the top header hands over to the next", () => {
	const init: Record<string, string> = {};
	ORDER.forEach((name, i) => (init[name] = `10.0.0.${i + 1}`));
	for (let i = 0; i < ORDER.length; i++) {
		const headers = h(init);
		for (let j = 0; j < i; j++) headers.delete(ORDER[j]);
		assertEquals(getClientIpFromHeaders(headers), `10.0.0.${i + 1}`, ORDER[i]);
	}
});

Deno.test("client-ip: x-client-ip beats x-forwarded-for", () => {
	assertEquals(
		getClientIpFromHeaders(
			h({ "x-forwarded-for": "9.9.9.9", "x-client-ip": "8.8.8.8" }),
		),
		"8.8.8.8",
	);
});

Deno.test("client-ip: an invalid higher-precedence header falls through", () => {
	assertEquals(
		getClientIpFromHeaders(h({ "x-client-ip": "nope", "x-real-ip": "8.8.8.8" })),
		"8.8.8.8",
	);
	// an XFF list with no valid token does not block the next header either
	assertEquals(
		getClientIpFromHeaders(
			h({ "x-forwarded-for": "unknown, nope", "cf-connecting-ip": "7.7.7.7" }),
		),
		"7.7.7.7",
	);
});

Deno.test("client-ip: x-forwarded-for — first VALID token wins, whitespace ignored", () => {
	const xff = (v: string) => getClientIpFromHeaders(h({ "x-forwarded-for": v }));
	assertEquals(xff("9.9.9.9, 10.0.0.1"), "9.9.9.9");
	assertEquals(xff("unknown, 9.9.9.9, 10.0.0.1"), "9.9.9.9");
	assertEquals(xff("  9.9.9.9 ,10.0.0.1"), "9.9.9.9");
	assertEquals(xff("9.9.9.9"), "9.9.9.9");
});

Deno.test("client-ip: IPv4 host:port reduces to the host", () => {
	assertEquals(
		getClientIpFromHeaders(h({ "x-forwarded-for": "1.2.3.4:5678, 10.0.0.1" })),
		"1.2.3.4",
	);
	assertEquals(getClientIpFromHeaders(h({ "x-real-ip": "1.2.3.4:5678" })), "1.2.3.4");
});

Deno.test("client-ip: IPv6 literals are accepted; bracketed host:port is not", () => {
	assertEquals(
		getClientIpFromHeaders(h({ "x-real-ip": "2001:db8::1" })),
		"2001:db8::1",
	);
	assertEquals(getClientIpFromHeaders(h({ "x-client-ip": "::1" })), "::1");
	assertEquals(
		getClientIpFromHeaders(h({ "x-forwarded-for": "2001:db8::1, 10.0.0.1" })),
		"2001:db8::1",
	);
	assertEquals(getClientIpFromHeaders(h({ "x-real-ip": "[2001:db8::1]:443" })), null);
});

Deno.test("client-ip: garbage, absent or RFC 7239 `Forwarded` → null", () => {
	assertEquals(getClientIpFromHeaders(new Headers()), null);
	assertEquals(getClientIpFromHeaders(h({ "x-real-ip": "" })), null);
	assertEquals(getClientIpFromHeaders(h({ "x-real-ip": "not-an-ip" })), null);
	assertEquals(getClientIpFromHeaders(h({ "x-real-ip": "999.1.1.1" })), null);
	assertEquals(getClientIpFromHeaders(h({ "x-real-ip": "example.com" })), null);
	assertEquals(getClientIpFromHeaders(h({ "x-forwarded-for": "unknown, nope" })), null);
	// request-ip never parsed `for=` either — the header is intentionally unsupported
	assertEquals(getClientIpFromHeaders(h({ forwarded: "for=1.2.3.4" })), null);
});
