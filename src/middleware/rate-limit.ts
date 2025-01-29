import { HTTP_ERROR } from "@marianmeres/http-utils";
import type { DeminoContext, DeminoLogger } from "../demino.ts";
import { TokenBucket } from "../mod.ts";

/** Option passed to `rateLimit` middleware. */
export interface RateLimitOptions {
	/** Max bucket size. Default is 20 */
	maxSize: number;
	/** Default is 10 */
	refillSizePerSecond: number;
	/**
	 * How often should we collect garbage? Garbage collect here means, that we simply
	 * delete old clients records continually as we go, so it will not slowly consume memory.
	 *
	 * Default value is 0.001 (that is every one in a thousand requests we'll do the cleanup).
	 * Zero means no cleanup, 1 means cleanup on every request (which makes no sense).
	 */
	cleanupProbability: number;
}

/**
 * Will create a rate limit middleware which will throw "429 Too Many Requests" if rate is exceeded.
 *
 * Uses token bucket algorithm internally with default options of allowing
 * 10 requests per second with a burst capacity of 20.
 *
 * Currently suitable only for single-server setups.
 * @todo support for distributes system (with Redis or similar)
 *
 * @example
 * ```ts
 * app.use('/api', rateLimit((req) => req.headers.get('Authorization')));
 * ```
 */
export function rateLimit(
	/** Function to identify current client making the request. */
	getClientId: (
		req: Request,
		info: Deno.ServeHandlerInfo,
		ctx: DeminoContext
	) => Promise<unknown>,
	options?: Partial<RateLimitOptions>
) {
	const {
		maxSize = 20,
		refillSizePerSecond = 10,
		cleanupProbability = 0.001,
	} = options ?? {};
	const clients = new Map<unknown, { bucket: TokenBucket; lastAccess: Date }>();

	if (cleanupProbability < 0 || cleanupProbability > 1) {
		throw new TypeError(`Expecting number between 0 and 1`);
	}

	/**  */
	const _maybeCleanup = (logger: DeminoLogger | null) => {
		if (Math.random() <= cleanupProbability) {
			let counter = 0;
			for (const [id, row] of clients.entries()) {
				if (
					(new Date().valueOf() - row.lastAccess.valueOf()) / 1_000 >=
					// calculate threshold automatically - anything older will be fully refilled anyway
					maxSize / refillSizePerSecond
				) {
					clients.delete(id);
					counter++;
				}
			}
			logger?.debug?.(`[rateLimit] Cleaned up '${counter}`);
		}
	};

	return async (
		req: Request,
		info: Deno.ServeHandlerInfo,
		ctx: DeminoContext
	) => {
		const logger = ctx.getLogger();
		_maybeCleanup(logger);

		const clientId = await getClientId(req, info, ctx);

		// return no-op if we can't recognize
		if (!clientId) return;

		// initialize on the first request
		if (!clients.has(clientId)) {
			clients.set(clientId, {
				bucket: new TokenBucket(maxSize, refillSizePerSecond),
				lastAccess: new Date(),
			});
		}

		const { bucket } = clients.get(clientId)!;

		if (!bucket.consume(1)) {
			throw new HTTP_ERROR.TooManyRequests();
		}
	};
}
