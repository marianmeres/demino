import { createResponseFrom, type DeminoHandler } from "../demino.ts";

export interface ETagOptions {
	/**
	 * Generate weak ETags (W/"...") instead of strong ones.
	 * Weak ETags are faster but semantically less precise.
	 * Default: false
	 */
	weak?: boolean;
	/**
	 * Maximum response body size (in bytes) eligible for ETag generation. The
	 * middleware buffers the entire response body in memory to compute the
	 * SHA-1 hash, so large responses are a memory hazard.
	 *
	 * If the response advertises a `Content-Length` greater than this value, or
	 * if the buffered body turns out to exceed it, the middleware skips
	 * hashing and returns the response unchanged (no ETag added, no 304
	 * negotiation). Set to `0` (or `Infinity`) to disable the cap.
	 *
	 * Default: 1_048_576 (1 MiB).
	 */
	maxSizeBytes?: number;
}

/**
 * Wraps a route handler to automatically generate ETags and handle conditional requests.
 *
 * Features:
 * - Generates ETag from response body hash (SHA-1)
 * - Handles If-None-Match header (returns 304 if match)
 * - Only processes GET/HEAD requests with 2xx responses
 * - Supports both strong and weak ETags
 *
 * Note: This reads the entire response body into memory to compute the hash.
 * For large responses, consider implementing streaming ETags or using file metadata.
 *
 * @example
 * ```ts
 * import { withETag } from "@marianmeres/demino";
 *
 * app.get("/api/users", withETag(async () => {
 *   const users = await db.getUsers();
 *   return users;
 * }));
 *
 * // First request: 200 with ETag: "abc123..."
 * // Second request with If-None-Match: "abc123..." -> 304 Not Modified (no body)
 * ```
 */
export function withETag(
	handler: DeminoHandler,
	options?: ETagOptions,
): DeminoHandler {
	const { weak = false, maxSizeBytes = 1_048_576 } = options ?? {};
	const sizeCap = !maxSizeBytes || maxSizeBytes === Infinity ? Infinity : maxSizeBytes;

	return async (req, info, ctx) => {
		// Only process GET and HEAD methods
		if (!["GET", "HEAD"].includes(req.method)) {
			return handler(req, info, ctx);
		}
		const isHead = req.method === "HEAD";

		// Execute the original handler
		let result = await handler(req, info, ctx);

		// Convert non-Response results to a Response. Use GET semantics even for a
		// HEAD (a synthetic GET request) so the ETag is computed over the SAME bytes a
		// GET would return — HEAD must share the GET validator, and `createResponseFrom`
		// would otherwise empty the HEAD body and hash the empty string. The body is
		// stripped again for HEAD at every return below.
		if (!(result instanceof Response)) {
			const convReq = isHead
				? new Request(new URL(req.url), { method: "GET" })
				: req;
			result = createResponseFrom(convReq, result, ctx.headers, ctx.status);
		}

		// Only process successful responses (2xx)
		if (result.status < 200 || result.status >= 300) {
			return result;
		}

		// If response already has ETag, don't override
		if (result.headers.has("etag")) {
			return result;
		}

		// Skip large responses up-front when Content-Length advertises the size.
		// (We can't trust the absence of the header — `arrayBuffer()` below has
		// the second-line defense for when the body is actually larger.)
		const contentLength = Number(result.headers.get("content-length"));
		if (Number.isFinite(contentLength) && contentLength > sizeCap) {
			return result;
		}

		// Read response body (this consumes the stream)
		const body = await result.arrayBuffer();

		// Emit the terminal 200 response. HEAD carries no body but must report the
		// Content-Length it WOULD have sent (parity with the GET it mirrors).
		const build = (headers: Headers): Response => {
			if (isHead) headers.set("content-length", String(body.byteLength));
			return new Response(isHead ? null : body, {
				status: result.status,
				statusText: result.statusText,
				headers,
			});
		};

		if (body.byteLength > sizeCap) {
			// Body is past the cap; we already consumed the stream so we have to
			// rebuild the response from the buffered bytes, but we skip hashing.
			return build(new Headers(result.headers));
		}

		// Generate ETag using SHA-1 hash
		const hashBuffer = await crypto.subtle.digest("SHA-1", body);
		const hashArray = Array.from(new Uint8Array(hashBuffer));
		const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0"))
			.join("");

		const etagValue = weak ? `W/"${hashHex}"` : `"${hashHex}"`;

		// Check If-None-Match header
		const ifNoneMatch = req.headers.get("if-none-match");
		if (ifNoneMatch) {
			// Support both single and multiple ETags in If-None-Match
			const requestETags = ifNoneMatch.split(",").map((e) => e.trim());
			// RFC 9110 §13.1.2: If-None-Match uses the WEAK comparison function — the
			// `W/` prefix is ignored, so `"abc"` and `W/"abc"` are equivalent. A plain
			// string compare would spuriously miss a matching weak/strong variant and
			// serve a full 200 where a 304 was warranted.
			const _bare = (t: string) => t.replace(/^W\//, "");
			const _target = _bare(etagValue);
			if (
				requestETags.includes("*") ||
				requestETags.some((t) => _bare(t) === _target)
			) {
				// 304 Not Modified. Carry forward the caching-relevant headers a
				// cache needs to keep a stored response valid (RFC 9110 §15.4.5),
				// not just Cache-Control — dropping Vary in particular can cause a
				// shared cache to serve the wrong negotiated variant.
				const h304 = new Headers({ etag: etagValue });
				for (
					const name of [
						"cache-control",
						"vary",
						"content-location",
						"expires",
						"date",
						"content-language",
					]
				) {
					const v = result.headers.get(name);
					if (v) h304.set(name, v);
				}
				return new Response(null, { status: 304, headers: h304 });
			}
		}

		// Return new response with ETag header
		const headers = new Headers(result.headers);
		headers.set("etag", etagValue);
		return build(headers);
	};
}
