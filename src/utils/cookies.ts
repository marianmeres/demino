/**
 * Cookie serialization options.
 */
export interface CookieOptions {
	/** Max age in seconds */
	maxAge?: number;
	/** Expiration date */
	expires?: Date;
	/** Cookie path */
	path?: string;
	/** Cookie domain */
	domain?: string;
	/** Only send over HTTPS */
	secure?: boolean;
	/** Prevent JavaScript access */
	httpOnly?: boolean;
	/** SameSite attribute */
	sameSite?: "Strict" | "Lax" | "None";
}

/**
 * Parse the Cookie header string into key-value pairs.
 *
 * @param cookieHeader - The raw Cookie header string (e.g., "foo=bar; baz=qux")
 * @returns Object with cookie names as keys and decoded values
 *
 * @example
 * ```ts
 * const cookies = parseCookies(req.headers.get("cookie"));
 * console.log(cookies.sessionId);
 * ```
 */
export function parseCookies(
	cookieHeader: string | null,
): Record<string, string> {
	if (!cookieHeader) return {};
	const cookies: Record<string, string> = {};
	for (const pair of cookieHeader.split(";")) {
		const trimmed = pair.trim();
		if (!trimmed) continue;
		const eqIndex = trimmed.indexOf("=");
		if (eqIndex === -1) continue;
		const key = trimmed.slice(0, eqIndex).trim();
		const value = trimmed.slice(eqIndex + 1).trim();
		if (key) {
			try {
				cookies[key] = decodeURIComponent(value);
			} catch {
				// If decoding fails, use raw value
				cookies[key] = value;
			}
		}
	}
	return cookies;
}

/**
 * Serialize a cookie name-value pair with options into a Set-Cookie header value.
 *
 * @param name - Cookie name
 * @param value - Cookie value
 * @param options - Cookie options (path, maxAge, httpOnly, etc.)
 * @returns Formatted Set-Cookie header value
 *
 * @example
 * ```ts
 * ctx.headers.append("set-cookie", serializeCookie("session", "abc123", {
 *   httpOnly: true,
 *   secure: true,
 *   sameSite: "Lax",
 *   path: "/",
 *   maxAge: 3600
 * }));
 * ```
 */
export function serializeCookie(
	name: string,
	value: string,
	options: CookieOptions = {},
): string {
	let cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;

	if (options.maxAge != null) {
		cookie += `; Max-Age=${options.maxAge}`;
	}
	if (options.expires) {
		cookie += `; Expires=${options.expires.toUTCString()}`;
	}
	if (options.path) {
		cookie += `; Path=${options.path}`;
	}
	if (options.domain) {
		cookie += `; Domain=${options.domain}`;
	}
	if (options.secure) {
		cookie += "; Secure";
	}
	if (options.httpOnly) {
		cookie += "; HttpOnly";
	}
	if (options.sameSite) {
		cookie += `; SameSite=${options.sameSite}`;
	}

	return cookie;
}
