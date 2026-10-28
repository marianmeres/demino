/**
 * Deno runtime adapter: `serve()` over `Deno.serve`.
 *
 * Starts the HTTP server, calls the handler with a filled-in
 * {@linkcode DeminoServeInfo} (`remoteAddr`, `upgradeWebSocket`, `raw`) and
 * returns the shared {@linkcode ServeHandle}.
 *
 * This is the only module in `src/` allowed to say `Deno.` at runtime, and even
 * here the slice of the namespace it uses is typed locally, so the file compiles
 * without Deno's ambient types.
 *
 * @example
 * ```ts
 * import { demino } from "@marianmeres/demino";
 * import { serve } from "@marianmeres/demino/deno";
 *
 * const app = demino();
 * app.get("/", () => "Hello");
 *
 * const server = await serve(app, { port: 8000 });
 * // ... later
 * await server.shutdown();
 * ```
 *
 * @module
 */

import type { DeminoServeHandler, DeminoServeInfo } from "../demino.ts";
import { logListenInfo } from "../utils/log-listen-info.ts";
import { type ServeFn, type ServeHandle, type ServeOptions, toUrl } from "./types.ts";

/** `Deno.NetAddr` as this adapter reads it. */
interface DenoNetAddr {
	hostname: string;
	port: number;
	transport: string;
}

/** `Deno.HttpServer` as this adapter reads it. */
interface DenoHttpServer {
	addr: DenoNetAddr;
	finished: Promise<void>;
	shutdown(): Promise<void>;
	ref(): void;
	unref(): void;
}

/**
 * The slice of the `Deno` namespace this adapter uses, typed locally so the
 * module type-checks under a plain `tsc` run without Deno's ambient types.
 */
interface DenoRuntime {
	serve(
		options: Record<string, unknown>,
		handler: (
			req: Request,
			info: { remoteAddr: DenoNetAddr },
		) => Response | Promise<Response>,
	): DenoHttpServer;
	upgradeWebSocket(
		req: Request,
		options?: { protocol?: string; idleTimeout?: number },
	): { socket: WebSocket; response: Response };
}

const D = (globalThis as unknown as { Deno?: DenoRuntime }).Deno;

/**
 * Starts a Demino app (or any {@linkcode DeminoServeHandler}) on `Deno.serve`.
 *
 * Defaults follow `Deno.serve`: `0.0.0.0:8000`, `onListen` prints the listen
 * info (see `logListenInfo`). `info.upgradeWebSocket` is `Deno.upgradeWebSocket`.
 * `options.webSockets` is ignored (Deno always has the capability).
 *
 * @param handler - The app or composed handler
 * @param options - Listen options (see {@linkcode ServeOptions})
 * @returns The running server's {@linkcode ServeHandle}
 * @throws Error when the `Deno` global is missing (use the `/node` adapter)
 */
// async on purpose: a synchronous throw from `Deno.serve` (e.g. port in use) must
// surface as a rejection, like every other adapter failure
// deno-lint-ignore require-await
export const serve: ServeFn = async (
	handler: DeminoServeHandler,
	options: ServeOptions = {},
): Promise<ServeHandle> => {
	if (!D) {
		throw new Error(
			"@marianmeres/demino/deno: `Deno` is not defined - use the /node adapter",
		);
	}

	const upgradeWebSocket = D.upgradeWebSocket.bind(D);

	const serveOptions: Record<string, unknown> = {
		port: options.port ?? 8000,
		hostname: options.hostname ?? "0.0.0.0",
		onListen: options.onListen ?? logListenInfo,
	};
	// only forward what was given, so `Deno.serve` keeps its own defaults otherwise
	if (options.signal) serveOptions.signal = options.signal;
	if (options.onError) serveOptions.onError = options.onError;

	const server = D.serve(serveOptions, (req, denoInfo) => {
		// `remoteAddr` is a lazy getter on Deno's info object that throws once the
		// request is closed - read it now, while the request is alive
		const info: DeminoServeInfo = {
			remoteAddr: denoInfo.remoteAddr,
			upgradeWebSocket,
			raw: denoInfo,
		};
		return handler(req, info);
	});

	const { hostname, port } = server.addr;

	const handle: ServeHandle = {
		hostname,
		port,
		url: toUrl({ hostname, port }),
		finished: server.finished,
		async shutdown() {
			await server.shutdown();
			await server.finished;
		},
		ref: () => server.ref(),
		unref: () => server.unref(),
	};

	return handle;
};
