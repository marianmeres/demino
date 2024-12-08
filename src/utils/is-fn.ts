// deno-lint-ignore-file no-explicit-any

/** Checks if value is a function */
export function isFn(v: any): boolean {
	return typeof v === "function";
}
