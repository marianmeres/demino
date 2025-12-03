import type { DeminoLogger } from "../demino.ts";

/**
 * Token bucket algorithm implementation for rate limiting.
 *
 * The token bucket is a simple but effective rate limiting strategy:
 * - Tokens are added to the bucket at a fixed rate (e.g., 10 tokens/second)
 * - Each request consumes one or more tokens
 * - If enough tokens exist, the request proceeds and tokens are removed
 * - If insufficient tokens, the request is rejected
 * - Maximum capacity prevents token hoarding
 *
 * This allows for bursting (up to maxSize requests instantly) while maintaining
 * a sustainable rate limit (refillPerSecond requests/second on average).
 *
 * @see https://lucia-auth.com/rate-limit/token-bucket
 *
 * @example Basic usage
 * ```ts
 * const bucket = new TokenBucket(20, 10); // 20 burst, 10/sec sustained
 *
 * if (bucket.consume()) {
 *   // Request allowed
 * } else {
 *   // Rate limited - reject with 429
 * }
 * ```
 *
 * @example Higher cost operations
 * ```ts
 * // Login attempts cost 5 tokens
 * if (bucket.consume(5)) {
 *   // Proceed with login
 * }
 * ```
 */
export class TokenBucket {
	/** Max allowed (burst) capacity */
	#maxSize: number;

	/** Current quantity in the bucket */
	#currentSize: number;

	/** Last refill timestamp */
	#lastRefill: Date;

	/** How much capacity will be refilled per second */
	#refillSizePerSec: number;

	/**
	 * Creates a new TokenBucket instance.
	 *
	 * @param maxSize - Maximum bucket capacity (burst limit). Must be positive.
	 * @param refillPerSecond - Tokens added per second (sustained rate). Must be positive.
	 * @param _logger - Optional logger for debugging token bucket operations
	 * @throws {TypeError} If maxSize or refillPerSecond is not a positive number
	 *
	 * @example
	 * ```ts
	 * // Allow 20 request burst, sustain 10 requests/second
	 * const bucket = new TokenBucket(20, 10);
	 *
	 * // With debug logging
	 * const bucket = new TokenBucket(20, 10, console);
	 * ```
	 */
	constructor(
		maxSize: number,
		refillPerSecond: number,
		protected _logger?: DeminoLogger | null,
	) {
		[maxSize, refillPerSecond].forEach((v) => {
			if (v <= 0) {
				throw new TypeError(`Expecting positive non-zero value, got '${v}'`);
			}
		});

		this.#maxSize = maxSize;
		this.#currentSize = maxSize;
		this.#lastRefill = new Date();
		this.#refillSizePerSec = refillPerSecond;
	}

	/**
	 * Refills the bucket based on time elapsed since last refill.
	 * Called automatically by `consume()` and `size` getter.
	 *
	 * @returns This TokenBucket instance for chaining
	 */
	refill(): TokenBucket {
		const now = new Date();
		const secondsPassed = (now.valueOf() - this.#lastRefill.valueOf()) / 1000;
		const countToAdd = Math.round(secondsPassed * this.#refillSizePerSec);

		// make sure to prevent capacity hoarding by using Math.min
		this.#currentSize = Math.min(this.#maxSize, this.#currentSize + countToAdd);
		this.#lastRefill = now;

		// for debugging
		this._logger?.debug?.("[TokenBucket]", {
			secondsPassed,
			countToAdd,
			currentSize: this.#currentSize,
			maxSize: this.#maxSize,
		});

		return this;
	}

	/**
	 * Attempts to consume tokens from the bucket.
	 * Automatically refills before checking capacity.
	 *
	 * @param quantity - Number of tokens to consume (default: 1)
	 * @returns true if tokens were consumed, false if insufficient capacity
	 */
	consume(quantity = 1): boolean {
		// First refill the bucket based on time passed
		this.refill();

		// sanitize
		if (Number.isNaN(quantity) || quantity < 0) {
			this._logger?.warn?.(
				`[TokenBucket] Invalid consume quantity '${quantity}'`,
			);
			return false;
		}

		// Check if we have enough capacity, if so, decrease and return true
		if (this.#currentSize >= quantity) {
			this.#currentSize -= quantity;
			return true;
		}

		return false;
	}

	/**
	 * Gets the current available token capacity.
	 * Automatically refills before returning the value.
	 */
	get size(): number {
		this.refill();
		return this.#currentSize;
	}
}
