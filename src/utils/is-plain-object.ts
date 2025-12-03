/**
 * Checks if a value is a plain object (not an instance of a class).
 *
 * A plain object is one created with `{}` or `Object.create(null)`,
 * not an instance of a custom class or built-in like Array, Date, etc.
 *
 * @param v - The value to check
 * @returns true if value is a plain object, false otherwise
 *
 * @example
 * ```ts
 * isPlainObject({}); // true
 * isPlainObject({ foo: "bar" }); // true
 * isPlainObject(Object.create(null)); // true
 * isPlainObject([]); // false
 * isPlainObject(new Date()); // false
 * isPlainObject(null); // false
 * isPlainObject(new MyClass()); // false
 * ```
 */
export function isPlainObject(v: any): v is Record<string, unknown> {
	return (
		v !== null &&
		typeof v === "object" &&
		[undefined, Object].includes(v.constructor)
	);
}
