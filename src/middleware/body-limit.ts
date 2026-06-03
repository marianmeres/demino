import { createHttpError, HTTP_ERROR } from "@marianmeres/http-utils";
import type { DeminoContext, DeminoHandler } from "../demino.ts";

/**
 * Configuration options for the body limit middleware.
 */
export interface BodyLimitOptions {
	/**
	 * Maximum allowed request body size in bytes. Requests whose `Content-Length`
	 * header exceeds this value are rejected with `413 Payload Too Large` before
	 * the body is ever read.
	 */
	maxSize: number;
	/**
	 * Allow requests that carry a body but do NOT declare a `Content-Length`
	 * (e.g. `Transfer-Encoding: chunked` streaming uploads).
	 *
	 * Default is `false` — such requests are rejected with `411 Length Required`,
	 * because their size cannot be known up front and `Deno.serve` would otherwise
	 * read the (potentially unbounded) stream into memory if a handler consumed it.
	 *
	 * Enable this ONLY if you knowingly accept streaming uploads and enforce a size
	 * bound yourself while reading the body.
	 *
	 * Default is `false`.
	 */
	allowUnknownLength?: boolean;
}

/**
 * Creates a middleware that enforces a maximum request body size, protecting the
 * server from memory exhaustion caused by large (accidental or malicious) uploads.
 *
 * It is a pure pre-handler header gate — it inspects headers only and never reads
 * (consumes) the request body, so it composes cleanly with downstream body parsing
 * and streaming/progress handling.
 *
 * How the size guarantee works:
 * - If `Content-Length` is present and exceeds `maxSize` → `413 Payload Too Large`
 *   (rejected before any byte is buffered).
 * - If `Content-Length` is present and within `maxSize` → allowed. `Deno.serve`
 *   uses the declared length as the read ceiling, so a handler can never receive
 *   more than the advertised bytes (an under-declared `Content-Length` cannot be
 *   used to smuggle extra bytes past the limit).
 * - If the request carries a body but declares NO `Content-Length` (chunked) →
 *   `411 Length Required`, unless `allowUnknownLength` is set.
 * - Requests with no body (GET/HEAD/empty POST) pass through untouched.
 *
 * Note: this is request-side protection. It is good practice to also configure a
 * body size limit in any reverse proxy in front of the app (e.g. nginx
 * `client_max_body_size`).
 *
 * @example Global limit (note: the global form is `app.use(mw)` with NO route)
 * ```ts
 * import { bodyLimit } from "@marianmeres/demino";
 *
 * app.use(bodyLimit({ maxSize: 20 * 1024 * 1024 })); // 20 MiB
 * ```
 *
 * @example Stricter limit on a specific route (stricter limit wins)
 * ```ts
 * app.post("/upload", bodyLimit({ maxSize: 5 * 1024 * 1024 }), handler);
 * ```
 *
 * @example Allow chunked / streaming uploads (enforce the bound yourself)
 * ```ts
 * app.use(bodyLimit({ maxSize: 50 * 1024 * 1024, allowUnknownLength: true }));
 * ```
 *
 * @param options - Body limit configuration.
 * @returns Middleware handler that rejects oversized requests.
 */
export function bodyLimit(options: BodyLimitOptions): DeminoHandler {
	const { maxSize, allowUnknownLength = false } = options;

	if (!Number.isFinite(maxSize) || maxSize < 0) {
		throw new TypeError(`Expecting "maxSize" to be a non-negative number`);
	}

	const midware: DeminoHandler = (
		req: Request,
		_info: Deno.ServeHandlerInfo,
		_ctx: DeminoContext,
	) => {
		// No body (GET/HEAD/empty POST) → nothing to limit.
		if (req.body === null) return;

		const raw = req.headers.get("content-length");
		const len = raw === null ? NaN : Number(raw);

		// Declared, valid length → we can decide deterministically.
		if (Number.isFinite(len) && len >= 0) {
			if (len > maxSize) {
				throw createHttpError(
					413,
					`Request body too large (max ${maxSize} bytes).`,
				);
			}
			// Within bounds. Deno bounds the actual read to this declared length,
			// so no handler can buffer more than `maxSize` bytes.
			return;
		}

		// Body present but no/invalid Content-Length (chunked / unknown length).
		if (!allowUnknownLength) {
			throw new HTTP_ERROR.LengthRequired(
				"A Content-Length header is required for requests with a body.",
			);
		}
		// allowUnknownLength: pass through — caller accepts responsibility for
		// bounding the stream while reading it.
	};

	// Allow layering (e.g. a tighter per-route limit on top of a global one).
	// With multiple gates the strictest throws first, which is the safe outcome.
	midware.__midwareDuplicable = true;
	return midware;
}
