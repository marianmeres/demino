/**
 * Runtime adapter contract.
 *
 * A runtime adapter is a small `serve()` function that starts an HTTP server on
 * one runtime (Deno, Node, Bun), calls a {@linkcode DeminoServeHandler} for every
 * request with a filled-in {@linkcode DeminoServeInfo}, and returns a
 * {@linkcode ServeHandle}. All adapters share this one signature, so an app's
 * `server.ts` differs between runtimes only in the adapter import path.
 *
 * This module holds types only (no runtime code), so it is safe to import from
 * core without pulling in any runtime adapter. Core never imports from
 * `adapters/` other than this file.
 *
 * @module
 */

import type { DeminoServeHandler } from "../demino.ts";
import type { DeminoListenAddr } from "../utils/log-listen-info.ts";

/** Options accepted by every runtime adapter's `serve()`. */
export interface ServeOptions {
	/**
	 * Port to listen on. `0` picks a free port (read the real one from
	 * {@linkcode ServeHandle.port}).
	 *
	 * @default 8000 (Deno.serve parity)
	 */
	port?: number;
	/**
	 * Hostname to bind.
	 *
	 * @default "0.0.0.0" (Deno.serve parity; Node's own default would be dual-stack "::")
	 */
	hostname?: string;
	/** Aborting the signal triggers {@linkcode ServeHandle.shutdown}. */
	signal?: AbortSignal;
	/**
	 * Called once the server is listening. Pass `() => {}` to silence (same idiom
	 * as `Deno.serve`).
	 *
	 * @default logListenInfo
	 */
	onListen?: (addr: DeminoListenAddr) => void;
	/**
	 * Last-resort error → Response. Demino apps never throw, so this is for the
	 * adapter's own failures.
	 *
	 * @default a plain-text 500
	 */
	onError?: (error: unknown) => Response | Promise<Response>;
	/**
	 * Node only: provide `info.upgradeWebSocket` via a lazily imported `ws`.
	 * Ignored by the other adapters.
	 *
	 * @default true
	 */
	webSockets?: boolean;
}

/** The running server, as returned by every runtime adapter's `serve()`. */
export interface ServeHandle {
	/** Bound hostname. */
	readonly hostname: string;
	/** Bound port (the real one, also when `port: 0` was requested). */
	readonly port: number;
	/**
	 * `http://<host>:<port>/` with IPv6 bracketed and unspecified addresses
	 * (`0.0.0.0`, `::`) rendered as `localhost`.
	 */
	readonly url: string;
	/**
	 * Resolves after {@linkcode ServeHandle.shutdown} completes (or the signal
	 * aborts) and the listener is closed.
	 */
	readonly finished: Promise<void>;
	/**
	 * Graceful shutdown: stop accepting, let in-flight requests finish. Node and
	 * Bun bound the wait (5 s) and then force-close.
	 */
	shutdown(): Promise<void>;
	/** Keep the process alive while the server runs (the default). */
	ref(): void;
	/** Let the process exit even while the server runs. */
	unref(): void;
}

/**
 * The shared `serve()` signature implemented by every runtime adapter.
 *
 * Returns a `Promise` on every runtime, even where the underlying server starts
 * synchronously (Deno), because Node's `listen` does not; one shape beats two.
 */
export type ServeFn = (
	handler: DeminoServeHandler,
	options?: ServeOptions,
) => Promise<ServeHandle>;
