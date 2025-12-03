/**
 * Checks if a value is a function.
 *
 * @param v - The value to check
 * @returns true if value is a function, false otherwise
 *
 * @example
 * ```ts
 * isFn(() => {}); // true
 * isFn(async () => {}); // true
 * isFn(class {}); // true
 * isFn("string"); // false
 * isFn(null); // false
 * ```
 */
export function isFn(v: any): v is CallableFunction {
	return typeof v === "function";
}
