import { assertEquals, assertRejects } from "@std/assert";
import { TimeoutError, withTimeout } from "../../src/utils/with-timeout.ts";

Deno.test("withTimeout: a synchronously-throwing fn returns a rejected promise", async () => {
	const boom = () => {
		throw new Error("sync boom");
	};
	const wrapped = withTimeout(boom, 1000);
	// Must NOT throw synchronously — calling it returns a promise that rejects, so
	// a caller can `.catch()` it like any other async result.
	const p = wrapped();
	await assertRejects(() => p, Error, "sync boom");
});

Deno.test("withTimeout: resolves a normal async fn", async () => {
	const wrapped = withTimeout((x: number) => Promise.resolve(x * 2), 1000);
	assertEquals(await wrapped(21), 42);
});

Deno.test("withTimeout: rejects with TimeoutError when exceeded (and aborts)", async () => {
	let aborted = false;
	const slow = (signal?: AbortSignal) =>
		new Promise((resolve) => {
			const id = setTimeout(resolve, 1000);
			signal?.addEventListener("abort", () => {
				aborted = true;
				clearTimeout(id);
			});
		});
	await assertRejects(() => withTimeout(slow, 20)(), TimeoutError);
	assertEquals(aborted, true);
});
