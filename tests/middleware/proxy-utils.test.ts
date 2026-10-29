import assert from "node:assert/strict";
import { test } from "node:test";
import { isHostAllowed, isPrivateHost } from "../../src/middleware/proxy/utils.ts";

test("isPrivateHost: private/loopback hosts", () => {
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
		assert.equal(isPrivateHost(h), true, `expected ${h} to be private`);
	}
});

test("isPrivateHost: public hosts", () => {
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
		assert.equal(isPrivateHost(h), false, `expected ${h} to be public`);
	}
});

test("isPrivateHost: IPv4-mapped IPv6 in HEX form (URL-normalized) is private", () => {
	// WHATWG URL normalizes `[::ffff:127.0.0.1]` to the hex serialization
	// `[::ffff:7f00:1]`. A dotted-decimal-only check would let these through,
	// which is exactly what the proxy passes to isPrivateHost (SSRF bypass).
	const truthy = [
		"::ffff:7f00:1", // 127.0.0.1
		"::ffff:a9fe:a9fe", // 169.254.169.254 (cloud metadata)
		"::ffff:c0a8:101", // 192.168.1.1
		"::ffff:0a00:1", // 10.0.0.1
		"[::ffff:7f00:1]", // bracketed
		"64:ff9b::7f00:1", // NAT64 of 127.0.0.1
		"64:ff9b::a9fe:a9fe", // NAT64 of 169.254.169.254
	];
	for (const h of truthy) {
		assert.equal(isPrivateHost(h), true, `expected ${h} to be private`);
	}
});

test("isPrivateHost: what the proxy actually sees after URL normalization is private", () => {
	// Prove the end-to-end path: the value the proxy passes is `new URL(...).hostname`.
	for (const raw of ["::ffff:127.0.0.1", "::ffff:169.254.169.254", "::ffff:10.0.0.1"]) {
		const hostname = new URL(`http://[${raw}]/`).hostname; // e.g. "[::ffff:7f00:1]"
		assert.equal(
			isPrivateHost(hostname),
			true,
			`expected ${raw} -> ${hostname} private`,
		);
	}
});

test("isPrivateHost: public IPv4-mapped IPv6 stays public", () => {
	// 8.8.8.8 mapped -> ::ffff:808:808 must NOT be misclassified as private.
	const falsy = ["::ffff:808:808", "::ffff:0808:0808", "64:ff9b::808:808"];
	for (const h of falsy) {
		assert.equal(isPrivateHost(h), false, `expected ${h} to be public`);
	}
});

test("isHostAllowed: empty/missing whitelist allows all", () => {
	assert.equal(isHostAllowed("anything.com"), true);
	assert.equal(isHostAllowed("anything.com", []), true);
});

test("isHostAllowed: exact match", () => {
	assert.equal(isHostAllowed("api.example.com", ["api.example.com"]), true);
	assert.equal(isHostAllowed("other.com", ["api.example.com"]), false);
});

test("isHostAllowed: matching is case-insensitive", () => {
	// hostnames are case-insensitive; a mixed-case allowlist entry must still match
	assert.equal(isHostAllowed("api.example.com", ["API.Example.COM"]), true);
	assert.equal(isHostAllowed("API.EXAMPLE.COM", ["api.example.com"]), true);
	assert.equal(isHostAllowed("sub.example.com", ["*.Example.com"]), true);
	assert.equal(isHostAllowed("other.com", ["API.Example.COM"]), false);
});

test("isHostAllowed: wildcard subdomain", () => {
	assert.equal(isHostAllowed("api.example.com", ["*.example.com"]), true);
	assert.equal(isHostAllowed("example.com", ["*.example.com"]), true);
	assert.equal(isHostAllowed("evil.com", ["*.example.com"]), false);
	assert.equal(isHostAllowed("api.evil-example.com", ["*.example.com"]), false);
});
