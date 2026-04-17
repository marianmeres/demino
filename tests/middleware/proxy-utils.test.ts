import { assertEquals } from "@std/assert";
import { isHostAllowed, isPrivateHost } from "../../src/middleware/proxy/utils.ts";

Deno.test("isPrivateHost: private/loopback hosts", () => {
	const truthy = [
		"localhost",
		"foo.localhost",
		"127.0.0.1",
		"127.1.2.3",
		"::1",
		"::",
		"0.0.0.0",
		"10.0.0.1",
		"10.255.255.255",
		"100.64.0.1",
		"100.127.255.255",
		"169.254.169.254",
		"172.16.0.1",
		"172.31.255.255",
		"192.168.0.1",
		"::ffff:127.0.0.1",
		"::ffff:0.0.0.0",
		"[::1]",
		"fe80::1",
		"fc00::1",
		"fd12:3456:789a::1",
	];
	for (const h of truthy) {
		assertEquals(isPrivateHost(h), true, `expected ${h} to be private`);
	}
});

Deno.test("isPrivateHost: public hosts", () => {
	const falsy = [
		"example.com",
		"8.8.8.8",
		"1.1.1.1",
		"100.63.0.1", // just outside CGNAT
		"100.128.0.1", // just outside CGNAT
		"172.15.0.1", // just outside 172.16/12
		"172.32.0.1", // just outside 172.16/12
		"169.253.0.1", // just outside link-local
		"2001:4860:4860::8888", // public IPv6
	];
	for (const h of falsy) {
		assertEquals(isPrivateHost(h), false, `expected ${h} to be public`);
	}
});

Deno.test("isHostAllowed: empty/missing whitelist allows all", () => {
	assertEquals(isHostAllowed("anything.com"), true);
	assertEquals(isHostAllowed("anything.com", []), true);
});

Deno.test("isHostAllowed: exact match", () => {
	assertEquals(isHostAllowed("api.example.com", ["api.example.com"]), true);
	assertEquals(isHostAllowed("other.com", ["api.example.com"]), false);
});

Deno.test("isHostAllowed: wildcard subdomain", () => {
	assertEquals(isHostAllowed("api.example.com", ["*.example.com"]), true);
	assertEquals(isHostAllowed("example.com", ["*.example.com"]), true);
	assertEquals(isHostAllowed("evil.com", ["*.example.com"]), false);
	assertEquals(
		isHostAllowed("api.evil-example.com", ["*.example.com"]),
		false,
	);
});
