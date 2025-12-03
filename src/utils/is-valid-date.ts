/**
 * Checks if a value is a valid Date object.
 *
 * A valid date is a Date instance that doesn't represent "Invalid Date".
 *
 * @param v - The value to check
 * @returns true if value is a valid Date, false otherwise
 *
 * @example
 * ```ts
 * isValidDate(new Date()); // true
 * isValidDate(new Date("2024-01-15")); // true
 * isValidDate(new Date("invalid")); // false (Invalid Date)
 * isValidDate(Date.now()); // false (number, not Date)
 * isValidDate("2024-01-15"); // false (string)
 * isValidDate(null); // false
 * ```
 */
export function isValidDate(v: any): v is Date {
	return v instanceof Date && !isNaN(v.getTime());
}
