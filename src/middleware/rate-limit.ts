import { HTTP_ERROR } from "@marianmeres/http-utils";
import type { DeminoContext, DeminoHandler, DeminoLogger } from "../demino.ts";
import { TokenBucket } from "../mod.ts";

/** Option passed to `rateLimit` middleware. */
export interface RateLimitOptions {
	/**
	 * What is the maximum number of requests one client is allowed to hit per second?
	 * This can be higher than the `refillSizePerSecond` to allow legit bursting.
	 * Default is 20.
	 */
	maxSize: number;
	/**
	 * What size (capacity) to refill per second?
	 * Default is 10
	 */
	refillSizePerSecond: number;
	/**
	 * How often should we collect garbage? Garbage collect here means that we simply
	 * delete old clients records continually as we go, so it will not slowly consume memory.
	 *
	 * Default value is 0.001 (that is every "one in a thousand" requests we'll do the cleanup).
	 * Zero means no cleanup, 1 means cleanup on every request.
	 */
	cleanupProbability: number;
	/**
	 * What size (capacity) should the current request consume? Point here is that certain
	 * requests (e.g. login attempts) may need to be limited with higher pressure...
	 *
	 * If not provided, size of 1 is assumed.
	 */
	getConsumeSize: (
		req: Request,
		info: Deno.ServeHandlerInfo,
		ctx: DeminoContext
	) => number | Promise<number>;
}

/**
 * Will create a rate limit middleware which will throw "429 Too Many Requests" if rate is exceeded.
 *
 * Uses token bucket algorithm internally with default options of allowing
 * 10 requests per second with a burst capacity of 20.
 *
 * For it to work, a `getClientId` function must be provided as a first argument, so it can
 * identify the source request and apply the limit. e.g. Auth Bearer token.
 *
 * Currently suitable only for single-server setups.
 * @todo support for distributes system (with Redis or similar)
 *
 * @example Using `Authorization` header as a client id
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
	) => unknown | Promise<unknown>,
	options?: Partial<RateLimitOptions>
): DeminoHandler {
	const {
		maxSize = 20,
		refillSizePerSecond = 10,
		cleanupProbability = 0.001,
		getConsumeSize,
	} = options ?? {};
	const clients = new Map<unknown, { bucket: TokenBucket; lastAccess: Date }>();

	if (cleanupProbability < 0 || cleanupProbability > 1) {
		throw new TypeError(`Expecting number between 0 and 1`);
	}

	/**  */
	const _maybeCleanup = (logger: DeminoLogger | null) => {
		if (Math.random() < cleanupProbability) {
			let counter = 0;
			for (const [id, row] of clients.entries()) {
				if (
					(new Date().valueOf() - row.lastAccess.valueOf()) / 1_000 >=
					// calculate threshold automatically (anything older will be fully refilled anyway)
					maxSize / refillSizePerSecond
				) {
					clients.delete(id);
					counter++;
				}
			}
			logger?.debug?.(`[rateLimit] Cleaned up: ${counter}`);
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

		// return no-op if we can't recognize the source
		if (!clientId) return;

		// initialize on the first request
		if (!clients.has(clientId)) {
			clients.set(clientId, {
				bucket: new TokenBucket(maxSize, refillSizePerSecond),
				lastAccess: new Date(),
			});
		}

		const { bucket } = clients.get(clientId)!;

		// what rate capacity size are we going to consume for this request?
		let consumeSize = 1;
		if (typeof getConsumeSize === "function") {
			consumeSize = await getConsumeSize(req, info, ctx);
		}

		if (!bucket.consume(consumeSize)) {
			throw new HTTP_ERROR.TooManyRequests();
		}
	};
}
