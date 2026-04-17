import { assert, assertEquals, assertThrows } from "@std/assert";
import { sleep, TokenBucket } from "../../src/mod.ts";

Deno.test("TokenBucket: starts at full capacity", () => {
	const b = new TokenBucket(5, 1);
	assertEquals(b.size, 5);
});

Deno.test("TokenBucket: consume reduces size", () => {
	const b = new TokenBucket(5, 1);
	assert(b.consume(2));
	assertEquals(b.size, 3);
});

Deno.test("TokenBucket: rejects consume when insufficient", () => {
	const b = new TokenBucket(2, 1);
	assert(b.consume(2));
	assertEquals(b.consume(1), false);
});

Deno.test("TokenBucket: invalid quantity returns false", () => {
	const b = new TokenBucket(5, 1);
	assertEquals(b.consume(NaN), false);
	assertEquals(b.consume(-1), false);
});

Deno.test("TokenBucket: throws on non-positive sizes", () => {
	assertThrows(() => new TokenBucket(0, 1), TypeError);
	assertThrows(() => new TokenBucket(1, 0), TypeError);
	assertThrows(() => new TokenBucket(-1, 1), TypeError);
});

// Regression: prior implementation used Math.round and reset lastRefill on every
// call. Calling consume() faster than ~50ms (with refill=10/s) caused
// countToAdd to round to 0 while lastRefill kept resetting, so the bucket
// never refilled.
Deno.test("TokenBucket: fast successive consume calls do not lose refill time", async () => {
	const b = new TokenBucket(2, 10); // 2 burst, 10/sec
	// Drain
	assert(b.consume(2));
	assertEquals(b.size, 0);
	// Hammer for ~250ms with no waits between calls — most of these are <10ms apart
	const deadline = Date.now() + 250;
	while (Date.now() < deadline) {
		b.consume(0); // refill check, no consumption
	}
	// At 10 tokens/sec we should have refilled ~2.5 tokens, capped at maxSize=2.
	assertEquals(b.size, 2, "bucket should refill despite fast successive calls");
});

Deno.test("TokenBucket: refill respects maxSize cap", async () => {
	const b = new TokenBucket(3, 100);
	b.consume(2);
	await sleep(50);
	// 100/s for 50ms = 5 tokens earned, but cap is 3
	assertEquals(b.size, 3);
});

Deno.test("TokenBucket: fractional time accumulates across calls", async () => {
	const b = new TokenBucket(10, 10); // 10/s
	b.consume(10); // drain
	assertEquals(b.size, 0);
	// Sleep 80ms — at 10/s that's 0.8 of a token, less than 1
	await sleep(80);
	assertEquals(b.size, 0, "no whole token earned yet");
	// Sleep another 50ms — total ~130ms = 1.3 tokens
	await sleep(50);
	const sz = b.size;
	assert(sz >= 1, `expected >= 1 token after 130ms, got ${sz}`);
});
