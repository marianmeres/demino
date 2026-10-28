import { lookup } from "mrmime";

/** Fallback for an unknown or missing extension. */
const OCTET_STREAM = "application/octet-stream";

/**
 * Non-`text/*` types that still get a `; charset=utf-8` parameter (what the 1.x
 * content-type lookup appended).
 */
const UTF8_TYPES = new Set([
	"application/json",
	"application/javascript",
	"application/xml",
	"image/svg+xml",
]);

/**
 * `Content-Type` for a file name or extension (`"foo.txt"`, `".txt"` and `"txt"`
 * all work), resolved through `mrmime`. Unknown → `application/octet-stream`.
 * Text-like types carry `; charset=utf-8`.
 */
export function contentTypeFor(fileNameOrExt: string): string {
	const type = lookup(fileNameOrExt) ?? OCTET_STREAM;
	return type.startsWith("text/") || UTF8_TYPES.has(type)
		? `${type}; charset=utf-8`
		: type;
}
