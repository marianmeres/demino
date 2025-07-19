/** Checks if value is a valid date */
export function isValidDate(v: any): boolean {
	return v instanceof Date && !isNaN(v.getTime());
}
