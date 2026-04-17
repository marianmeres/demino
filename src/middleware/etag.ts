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

		// Execute the original handler
		let result = await handler(req, info, ctx);

		// Convert non-Response results to Response using Demino's helper
		if (!(result instanceof Response)) {
			result = createResponseFrom(req, result, ctx.headers, ctx.status);
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
		if (body.byteLength > sizeCap) {
			// Body is past the cap; we already consumed the stream so we have to
			// rebuild the response from the buffered bytes, but we skip hashing.
			return new Response(body, {
				status: result.status,
				statusText: result.statusText,
				headers: result.headers,
			});
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
			if (requestETags.includes(etagValue) || requestETags.includes("*")) {
				// Return 304 Not Modified
				return new Response(null, {
					status: 304,
					headers: {
						"etag": etagValue,
						// Preserve cache-control if present
						...(result.headers.get("cache-control")
							? { "cache-control": result.headers.get("cache-control")! }
							: {}),
					},
				});
			}
		}

		// Return new response with ETag header
		const headers = new Headers(result.headers);
		headers.set("etag", etagValue);

		return new Response(body, {
			status: result.status,
			statusText: result.statusText,
			headers,
		});
	};
}
