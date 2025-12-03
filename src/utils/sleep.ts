/**
 * Delays execution for a specified number of milliseconds.
 *
 * A simple Promise-based sleep/delay utility for async code.
 *
 * @param timeout - Duration to sleep in milliseconds
 * @param __timeout_ref__ - Optional reference object to store the timeout ID.
 *   Useful when you need to cancel the sleep externally. Deno.test requires
 *   all timeouts to be cleared, so this is needed for Promise.race scenarios.
 * @returns A Promise that resolves after the timeout
 *
 * @example Basic usage
 * ```ts
 * await sleep(100); // Wait 100ms
 * console.log("Done!");
 * ```
 *
 * @example With cancellation support
 * ```ts
 * const ref = { id: -1 };
 * const sleepPromise = sleep(5000, ref);
 *
 * // Later, if you need to cancel:
 * clearTimeout(ref.id);
 * ```
 *
 * @example In rate limiting
 * ```ts
 * async function fetchWithDelay(urls: string[]) {
 *   for (const url of urls) {
 *     await fetch(url);
 *     await sleep(1000); // Rate limit: 1 request/second
 *   }
 * }
 * ```
 */
export function sleep(
	timeout: number,
	__timeout_ref__: { id: number } = { id: -1 },
): Promise<void> {
	return new Promise((resolve) => {
		__timeout_ref__.id = setTimeout(() => {
			clearTimeout(__timeout_ref__.id);
			resolve(undefined);
		}, timeout);
	});
}
