import type { DeminoLogger } from "../demino.ts";

/**
 * Inspired from https://lucia-auth.com/rate-limit/token-bucket
 *
 * Imagine a bucket that holds tokens. Tokens are added to the bucket at a fixed rate
 * (e.g. 10 tokens per second). Each API request consumes one or more tokens.
 * If there are enough tokens, the request is allowed and tokens are removed.
 * If there aren't enough tokens, the request is rejected.
 * The bucket has a maximum capacity to prevent token hoarding.
 */
export class TokenBucket {
	/** Max allowed (burst) capacity*/
	#maxSize: number;

	/** Current quantity in the bucket */
	#currentSize: number;

	/** Last refill timestamp */
	#lastRefill: Date;

	/** How much capacity will be refilled per second */
	#refillSizePerSec: number;

	/** */
	constructor(
		maxSize: number,
		refillPerSecond: number,
		protected _logger?: DeminoLogger | null
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

	/** Will "refill" quantity if enough seconds elapsed since last time. */
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

	/** Will "consume" quantity from available capacity. */
	consume(quantity = 1): boolean {
		// First refill the bucket based on time passed
		this.refill();

		// Check if we have enough tokens, if so, decrease and return true
		if (this.#currentSize >= quantity) {
			this.#currentSize -= quantity;
			return true;
		}

		return false;
	}

	/** Will get current available capacity */
	get size(): number {
		this.refill();
		return this.#currentSize;
	}
}
