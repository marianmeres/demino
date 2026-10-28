import assert from "node:assert/strict";
import { test } from "node:test";
import { TimeoutError, withTimeout } from "../../src/utils/with-timeout.ts";

test("withTimeout: a synchronously-throwing fn returns a rejected promise", async () => {
	const boom = () => {
		throw new Error("sync boom");
	};
	const wrapped = withTimeout(boom, 1000);
	// Must NOT throw synchronously — calling it returns a promise that rejects, so
	// a caller can `.catch()` it like any other async result.
	const p = wrapped();
	await assert.rejects(() => p, { name: "Error", message: "sync boom" });
});

test("withTimeout: resolves a normal async fn", async () => {
	const wrapped = withTimeout((x: number) => Promise.resolve(x * 2), 1000);
	assert.equal(await wrapped(21), 42);
});

test("withTimeout: rejects with TimeoutError when exceeded (and aborts)", async () => {
	let aborted = false;
	const slow = (signal?: AbortSignal) =>
		new Promise((resolve) => {
			const id = setTimeout(resolve, 1000);
			signal?.addEventListener("abort", () => {
				aborted = true;
				clearTimeout(id);
			});
		});
	await assert.rejects(() => withTimeout(slow, 20)(), TimeoutError);
	assert.equal(aborted, true);
});
