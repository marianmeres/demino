/**
 * Client IP resolution from proxy-forwarding headers.
 *
 * This is the header precedence the `request-ip` package (3.3.0) provided, inlined so
 * the core has no CommonJS dependency: a short ordered list of header names, each
 * accepted only when its value is a syntactically valid IP literal.
 *
 * Trust is NOT decided here. `demino()` consults these headers only when
 * `trustProxy` is on; with it off `ctx.ip` is the socket peer and nothing in this
 * module runs. See `docs/reverse-proxy-and-forwarded-headers.md`.
 *
 * @module
 */

import { isIP } from "node:net";

/**
 * Headers consulted, in order (same precedence as request-ip 3.3.0, headers only).
 *
 * `Forwarded` (RFC 7239) is deliberately absent: request-ip only accepted it when
 * the raw value was a bare IP, which a real `Forwarded: for=…` value never is.
 */
const HEADER_ORDER = [
	"x-client-ip",
	"x-forwarded-for",
	"cf-connecting-ip",
	"fastly-client-ip",
	"true-client-ip",
	"x-real-ip",
	"x-cluster-client-ip",
	"x-forwarded",
	"forwarded-for",
	"x-appengine-user-ip",
	"cf-pseudo-ipv4",
] as const;

/** `1.2.3.4:5678` — an IPv4 literal with a port appended, as some proxies emit. */
const IPV4_WITH_PORT = /^\d+\.\d+\.\d+\.\d+:\d+$/;

/**
 * Picks the client IP from proxy-forwarding headers, or `null` when none carries a
 * valid IP literal.
 *
 * Precedence: `X-Client-IP`, `X-Forwarded-For` (first VALID token of the comma list,
 * left to right), `CF-Connecting-IP`, `Fastly-Client-IP`, `True-Client-IP`,
 * `X-Real-IP`, `X-Cluster-Client-IP`, `X-Forwarded`, `Forwarded-For`,
 * `X-Appengine-User-IP`, `Cf-Pseudo-IPv4`. A value in the `1.2.3.4:5678` form is
 * reduced to its host part. Validation is `isIP` from `node:net`, so IPv6 literals
 * are accepted and anything else (`unknown`, hostnames, garbage) is skipped.
 *
 * SECURITY — every one of these headers is client-settable unless a trusted proxy
 * in front overwrites it. Call this only for requests that arrived through such a
 * proxy (what `trustProxy` asserts); `ctx.ip` is otherwise not a security input.
 *
 * @example
 * ```ts
 * getClientIpFromHeaders(new Headers({ "x-forwarded-for": "unknown, 9.9.9.9, 10.0.0.1" }));
 * // "9.9.9.9"
 * ```
 */
export function getClientIpFromHeaders(headers: Headers): string | null {
	for (const name of HEADER_ORDER) {
		const raw = headers.get(name);
		if (!raw) continue;
		const tokens = name === "x-forwarded-for" ? raw.split(",") : [raw];
		for (let token of tokens) {
			token = token.trim();
			if (IPV4_WITH_PORT.test(token)) {
				token = token.slice(0, token.lastIndexOf(":"));
			}
			if (isIP(token)) return token;
		}
	}
	return null;
}
