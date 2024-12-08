// deno-lint-ignore-file no-explicit-any

/** Checks if value is a valid date */
export function isValidDate(v: any) {
	return v instanceof Date && !isNaN(v.getTime());
}
