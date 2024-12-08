// deno-lint-ignore-file no-explicit-any

/** Checks if value is a plain object */
export function isPlainObject(v: any): boolean {
	return (
		v !== null &&
		typeof v === "object" &&
		[undefined, Object].includes(v.constructor)
	);
}
