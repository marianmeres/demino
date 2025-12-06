/**
 * Utility functions for proxy middleware.
 * @module
 */

/**
 * Checks if a hostname is a private/internal address (SSRF protection).
 *
 * Detects localhost, private IPv4 ranges (10.x.x.x, 172.16-31.x.x, 192.168.x.x,
 * 169.254.x.x, 127.x.x.x), and private IPv6 ranges (fe80::, fc/fd, ::1).
 *
 * @param hostname - The hostname or IP address to check
 * @returns true if the hostname is a private/internal address, false otherwise
 *
 * @example
 * ```ts
 * isPrivateHost("localhost");     // true
 * isPrivateHost("192.168.1.1");   // true
 * isPrivateHost("10.0.0.1");      // true
 * isPrivateHost("example.com");   // false
 * isPrivateHost("8.8.8.8");       // false
 * ```
 */
export function isPrivateHost(hostname: string): boolean {
	// localhost variations
	if (
		hostname === "localhost" ||
		hostname === "127.0.0.1" ||
		hostname === "::1" ||
		hostname.endsWith(".localhost")
	) {
		return true;
	}

	// Check for private IP ranges
	const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (ipv4Match) {
		const [, a, b] = ipv4Match.map(Number);
		// 10.0.0.0/8
		if (a === 10) return true;
		// 172.16.0.0/12
		if (a === 172 && b >= 16 && b <= 31) return true;
		// 192.168.0.0/16
		if (a === 192 && b === 168) return true;
		// 169.254.0.0/16 (link-local)
		if (a === 169 && b === 254) return true;
		// 127.0.0.0/8 (loopback)
		if (a === 127) return true;
	}

	// Check for private IPv6 ranges
	if (hostname.includes(":")) {
		const lower = hostname.toLowerCase();
		// Link-local (fe80::/10)
		if (lower.startsWith("fe80:")) return true;
		// Unique local (fc00::/7)
		if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
		// Loopback
		if (lower === "::1") return true;
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
