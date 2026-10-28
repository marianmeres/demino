import assert from "node:assert/strict";
import { test } from "node:test";
import { sleep, TokenBucket } from "../../src/mod.ts";

test("TokenBucket: starts at full capacity", () => {
	const b = new TokenBucket(5, 1);
	assert.equal(b.size, 5);
});

test("TokenBucket: consume reduces size", () => {
	const b = new TokenBucket(5, 1);
	assert.ok(b.consume(2));
	assert.equal(b.size, 3);
});

test("TokenBucket: rejects consume when insufficient", () => {
	const b = new TokenBucket(2, 1);
	assert.ok(b.consume(2));
	assert.equal(b.consume(1), false);
});

test("TokenBucket: invalid quantity returns false", () => {
	const b = new TokenBucket(5, 1);
	assert.equal(b.consume(NaN), false);
	assert.equal(b.consume(-1), false);
});

test("TokenBucket: throws on non-positive sizes", () => {
	assert.throws(() => new TokenBucket(0, 1), TypeError);
	assert.throws(() => new TokenBucket(1, 0), TypeError);
	assert.throws(() => new TokenBucket(-1, 1), TypeError);
});

// Regression: prior implementation used Math.round and reset lastRefill on every
// call. Calling consume() faster than ~50ms (with refill=10/s) caused
// countToAdd to round to 0 while lastRefill kept resetting, so the bucket
// never refilled.
test("TokenBucket: fast successive consume calls do not lose refill time", () => {
	const b = new TokenBucket(2, 10); // 2 burst, 10/sec
	// Drain
	assert.ok(b.consume(2));
	assert.equal(b.size, 0);
	// Hammer for ~250ms with no waits between calls — most of these are <10ms apart
	const deadline = Date.now() + 250;
	while (Date.now() < deadline) {
		b.consume(0); // refill check, no consumption
	}
	// At 10 tokens/sec we should have refilled ~2.5 tokens, capped at maxSize=2.
	assert.equal(b.size, 2, "bucket should refill despite fast successive calls");
});

test("TokenBucket: refill respects maxSize cap", async () => {
	const b = new TokenBucket(3, 100);
	b.consume(2);
	await sleep(50);
	// 100/s for 50ms = 5 tokens earned, but cap is 3
	assert.equal(b.size, 3);
});

test("TokenBucket: fractional time accumulates across calls", async () => {
	const b = new TokenBucket(10, 10); // 10/s
	b.consume(10); // drain
	assert.equal(b.size, 0);
	// Sleep 80ms — at 10/s that's 0.8 of a token, less than 1
	await sleep(80);
	assert.equal(b.size, 0, "no whole token earned yet");
	// Sleep another 50ms — total ~130ms = 1.3 tokens
	await sleep(50);
	const sz = b.size;
	assert.ok(sz >= 1, `expected >= 1 token after 130ms, got ${sz}`);
});
