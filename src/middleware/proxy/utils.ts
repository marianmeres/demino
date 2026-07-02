/**
 * Utility functions for proxy middleware.
 * @module
 */

/**
 * Checks if a hostname is a private/internal address (SSRF protection).
 *
 * Detects localhost, the unspecified address `0.0.0.0`, private IPv4 ranges
 * (10.x.x.x, 172.16-31.x.x, 192.168.x.x, 169.254.x.x, 127.x.x.x,
 * 100.64.0.0/10), private IPv6 ranges (fe80::/10, fc00::/7, ::1, the
 * unspecified `::`), and IPv4-mapped IPv6 forms of any of the above.
 *
 * Important caveat: this is a *string-only* check. It cannot detect a public
 * hostname that resolves (or is rebound) to a private IP. If you need
 * protection against DNS rebinding, resolve the hostname yourself (e.g.
 * `Deno.resolveDns`) and re-check each resulting address.
 *
 * @param hostname - The hostname or IP address to check
 * @returns true if the hostname is a private/internal address, false otherwise
 *
 * @example
 * ```ts
 * isPrivateHost("localhost");           // true
 * isPrivateHost("0.0.0.0");             // true
 * isPrivateHost("192.168.1.1");         // true
 * isPrivateHost("10.0.0.1");            // true
 * isPrivateHost("::ffff:127.0.0.1");    // true (IPv4-mapped IPv6)
 * isPrivateHost("example.com");         // false (does NOT do DNS lookup)
 * isPrivateHost("8.8.8.8");             // false
 * ```
 */
/**
 * Extracts the embedded IPv4 (as a dotted-decimal string) from an IPv6 literal that
 * carries one — IPv4-mapped (`::ffff:*`) and NAT64 (`64:ff9b::*`) — in either the
 * dotted (`::ffff:1.2.3.4`) or the hex-piece (`::ffff:7f00:1`) serialization. Returns
 * `null` when the host embeds no such IPv4.
 *
 * The hex form is the important one: WHATWG URL normalizes `[::ffff:127.0.0.1]` to
 * `[::ffff:7f00:1]`, so a check that only recognized the dotted form would let
 * loopback / `169.254.169.254` (cloud metadata) slip past {@link isPrivateHost}.
 *
 * @param lowerHost - The lower-cased, bracket-stripped hostname.
 */
function _embeddedIPv4(lowerHost: string): string | null {
	// dotted form (as some inputs / non-normalized callers may still supply)
	const dotted = lowerHost.match(
		/^(?:::ffff:|64:ff9b::)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/,
	);
	if (dotted) return dotted[1];

	// hex-piece form (two 16-bit groups == the 32 embedded IPv4 bits)
	const hex = lowerHost.match(/^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
	if (hex) {
		const hi = parseInt(hex[1], 16);
		const lo = parseInt(hex[2], 16);
		return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
	}

	return null;
}

export function isPrivateHost(hostname: string): boolean {
	// strip optional brackets used for IPv6 in URLs
	if (hostname.startsWith("[") && hostname.endsWith("]")) {
		hostname = hostname.slice(1, -1);
	}

	// localhost variations
	if (
		hostname === "localhost" ||
		hostname === "127.0.0.1" ||
		hostname === "::1" ||
		hostname === "::" ||
		hostname.endsWith(".localhost")
	) {
		return true;
	}

	// Extract the IPv4 portion of an IPv4-embedding IPv6 address before the IPv4
	// range check, so the same logic applies. Critically this handles the HEX
	// serialization (`::ffff:7f00:1`) too: the WHATWG URL parser normalizes mapped
	// literals to hex (`new URL("http://[::ffff:127.0.0.1]/").hostname` === "[::ffff:7f00:1]"),
	// so a dotted-decimal-only check would silently pass loopback / metadata (SSRF).
	const lowerHost = hostname.toLowerCase();
	const ipv4Candidate = _embeddedIPv4(lowerHost) ?? hostname;

	// Check for private IP ranges
	const ipv4Match = ipv4Candidate.match(
		/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/,
	);
	if (ipv4Match) {
		const [, a, b] = ipv4Match.map(Number);
		// 0.0.0.0 (unspecified — resolves to localhost on Linux)
		if (a === 0) return true;
		// 10.0.0.0/8
		if (a === 10) return true;
		// 100.64.0.0/10 (carrier-grade NAT)
		if (a === 100 && b >= 64 && b <= 127) return true;
		// 127.0.0.0/8 (loopback)
		if (a === 127) return true;
		// 169.254.0.0/16 (link-local, includes cloud metadata 169.254.169.254)
		if (a === 169 && b === 254) return true;
		// 172.16.0.0/12
		if (a === 172 && b >= 16 && b <= 31) return true;
		// 192.168.0.0/16
		if (a === 192 && b === 168) return true;
	}

	// Check for private IPv6 ranges (only meaningful if it actually contains ':')
	if (hostname.includes(":")) {
		// Link-local (fe80::/10)
		if (lowerHost.startsWith("fe80:")) return true;
		// Unique local (fc00::/7) — note: must be followed by the rest of an IPv6
		// address, so a literal "fc"-prefixed string still requires a colon.
		if (lowerHost.startsWith("fc") || lowerHost.startsWith("fd")) return true;
		// Loopback / unspecified
		if (lowerHost === "::1" || lowerHost === "::") return true;
	}

	return false;
}

/**
 * Validates if a host is allowed based on an optional whitelist.
 *
 * Supports exact matches and wildcard subdomain patterns (e.g., "*.example.com").
 * If no whitelist is provided or the list is empty, all hosts are allowed.
 *
 * @param hostname - The hostname to validate
 * @param allowedHosts - Optional array of allowed hosts (supports wildcards like "*.example.com")
 * @returns true if the hostname is allowed, false otherwise
 *
 * @example
 * ```ts
 * isHostAllowed("api.example.com", ["api.example.com"]);       // true
 * isHostAllowed("sub.example.com", ["*.example.com"]);         // true
 * isHostAllowed("example.com", ["*.example.com"]);             // true (base domain matches)
 * isHostAllowed("other.com", ["api.example.com"]);             // false
 * isHostAllowed("anything.com");                               // true (no whitelist)
 * ```
 */
export function isHostAllowed(
	hostname: string,
	allowedHosts?: string[],
): boolean {
	if (!allowedHosts || allowedHosts.length === 0) return true;

	return allowedHosts.some((allowed) => {
		// Exact match
		if (allowed === hostname) return true;
		// Wildcard subdomain match (e.g., "*.example.com")
		if (allowed.startsWith("*.")) {
			const domain = allowed.slice(2);
			return hostname === domain || hostname.endsWith("." + domain);
		}
		return false;
	});
}

/**
 * Standard headers that should be removed from proxy requests
 */
export const PROXY_REQUEST_REMOVE_HEADERS = [
	"connection",
	"keep-alive",
	"transfer-encoding",
	"upgrade",
	"expect",
] as const;

/**
 * Standard headers that should be removed from proxy responses
 */
export const PROXY_RESPONSE_REMOVE_HEADERS = [
	"connection",
	"keep-alive",
	"transfer-encoding",
] as const;
