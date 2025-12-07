import { type ClogConfig, createClog } from "@marianmeres/clog";
import type { DeminoLogger } from "../demino.ts";

/**
 * Creates a complete DeminoLogger instance using `@marianmeres/clog`.
 *
 * Provides all standard logging methods (log, debug, warn, error) plus
 * an access log handler for HTTP request logging.
 *
 * @param namespace - The clog namespace prefix for log output (default: "demino")
 * @param config - Optional clog configuration options
 * @returns A complete DeminoLogger instance
 *
 * @example
 * ```ts
 * import { demino, createDeminoClog } from "demino";
 *
 * const app = demino("/api", [], {
 *     logger: createDeminoClog("my-app"),
 * });
 * ```
 */
export function createDeminoClog(
	namespace: string = "demino",
	config: ClogConfig = {}
): DeminoLogger {
	const clog = createClog(namespace, config);
	return {
		...clog,
		access(data: {
			timestamp: Date;
			status: number;
			req: Request;
			ip: string | undefined;
			duration: number;
		}) {
			const { status, req, ip, duration } = data;
			const url = new URL(req.url);
			clog.log(
				`[ACCESS] ${ip ?? "-"} [${req.method.toUpperCase()}] ${url.pathname}${
					url.search
				} ${status} ${duration}ms`
			);
		},
	};
}
