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
 * Creates a new function that wraps the original and races it against a timer.
 * If the original function doesn't resolve/reject before the timeout,
 * the wrapper rejects with a TimeoutError.
 *
 * @typeParam T - The return type of the wrapped function
 * @param fn - The function to wrap (can be sync or async)
 * @param timeout - Timeout in milliseconds (default: 1000)
 * @param errMessage - Custom error message for timeout (default: "Timed out after X ms")
 * @returns A new function that returns a Promise with timeout enforcement
 *
 * @example Basic usage
 * ```ts
 * const slowFetch = async (url: string) => {
 *   const res = await fetch(url);
 *   return res.json();
 * };
 *
 * const timedFetch = withTimeout(slowFetch, 5000);
 *
 * try {
 *   const data = await timedFetch("https://api.example.com/data");
 * } catch (e) {
 *   if (e instanceof TimeoutError) {
 *     console.log("Request timed out after 5 seconds");
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
): (...args: any[]) => Promise<T> {
	return (...args: any[]): Promise<T> => {
		const _promise = fn(...args);

		let _timeoutId: number;
		const _clock = new Promise((_, reject) => {
			_timeoutId = setTimeout(() => {
				reject(new TimeoutError(errMessage || `Timed out after ${timeout} ms`));
			}, timeout);
		});

		return new Promise<T>((res, rej) => {
			return Promise.race([_promise, _clock])
				.then(res)
				.catch(rej)
				.finally(() => clearTimeout(_timeoutId));
		});
	};
}
