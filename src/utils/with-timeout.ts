/**
 * Error thrown when a wrapped function exceeds its timeout duration.
 *
 * @example
 * ```ts
 * try {
 *   await timedFetch();
 * } catch (e) {
 *   if (e instanceof TimeoutError) {
 *     console.log("Request timed out");
 *   }
 * }
 * ```
 */
export class TimeoutError extends Error {}

/**
 * Wraps a function to reject if execution exceeds a timeout.
 *
 * On timeout, the wrapper rejects with a `TimeoutError`. If the wrapped
 * function accepts an `AbortSignal` as its **last** argument, that signal will
 * also be aborted on timeout — which lets the underlying work (e.g. `fetch`)
 * actually cancel rather than continue running in the background.
 *
 * If the wrapped function ignores the signal, the work continues until it
 * completes naturally — but the wrapper has already rejected, so any result
 * is discarded.
 *
 * @typeParam T - The return type of the wrapped function
 * @param fn - The function to wrap (can be sync or async). Receives an
 *             `AbortSignal` as its last argument when invoked.
 * @param timeout - Timeout in milliseconds (default: 1000). Pass 0 to disable
 *                  the timer entirely.
 * @param errMessage - Custom error message for timeout (default: "Timed out after X ms")
 * @returns A new function that returns a Promise with timeout enforcement
 *
 * @example Basic usage with cancellable fetch
 * ```ts
 * const slowFetch = async (url: string, signal?: AbortSignal) => {
 *   const res = await fetch(url, { signal });
 *   return res.json();
 * };
 *
 * const timedFetch = withTimeout(slowFetch, 5000);
 *
 * try {
 *   const data = await timedFetch("https://api.example.com/data");
 * } catch (e) {
 *   if (e instanceof TimeoutError) {
 *     console.log("Request timed out after 5 seconds (and was cancelled)");
 *   }
 * }
 * ```
 *
 * @example With custom error message
 * ```ts
 * const timedDb = withTimeout(dbQuery, 3000, "Database query timed out");
 * ```
 */
export function withTimeout<T>(
	fn: CallableFunction,
	timeout: number = 1_000,
	errMessage?: string,
): (...args: unknown[]) => Promise<T> {
	return (...args: unknown[]): Promise<T> => {
		// Pass an AbortSignal so the wrapped function can actually cancel its
		// underlying work on timeout (e.g. abort an in-flight fetch). Functions
		// that don't take a signal will simply ignore it.
		const ac = new AbortController();
		const _promise = fn(...args, ac.signal) as Promise<T>;

		if (!timeout) return Promise.resolve(_promise);

		let _timeoutId: ReturnType<typeof setTimeout>;
		const _clock = new Promise<never>((_, reject) => {
			_timeoutId = setTimeout(() => {
				ac.abort();
				reject(new TimeoutError(errMessage || `Timed out after ${timeout} ms`));
			}, timeout);
		});

		return Promise.race([_promise, _clock]).finally(() => {
			clearTimeout(_timeoutId);
		});
	};
}
