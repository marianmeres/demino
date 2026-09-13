/**
 * Options for {@linkcode logListenInfo} and {@linkcode createLogListenInfo}.
 */
export interface LogListenInfoOptions {
	/**
	 * Emit a single structured JSON line instead of the human friendly colored
	 * output. Intended for containerized deployments where stdout is collected
	 * and shipped to a log aggregator (Axiom, Loki, Datadog, ...).
	 *
	 * `"auto"` decides at call time: JSON when stdout is not a TTY (the usual
	 * docker case), human output otherwise.
	 *
	 * @default false
	 */
	json?: boolean | "auto";

	/**
	 * Value of the JSON `logger` field. Matches the default field name used by
	 * `@marianmeres/clog`'s `jsonOutput`, so the line blends in with the rest of
	 * the app's structured logs.
	 *
	 * @default "demino"
	 */
	namespace?: string;

	/**
	 * Extra fields merged into the JSON object (service name, env, release, ...).
	 * Merged last, so it can also override any of the built-in fields.
	 *
	 * @default undefined
	 */
	fields?: Record<string, unknown>;

	/**
	 * Custom sink, called once per output line. In JSON mode it receives the
	 * serialized JSON line; in human mode the plain (unstyled) text lines.
	 *
	 * @default console.log
	 */
	write?: (line: string) => void;
}

/** IPv6 literals must be bracketed in a URL authority (`http://[::1]:8000/`). */
const fmtHost = (h: string) => (h.includes(":") ? `[${h}]` : h);

/**
 * Both the IPv4 (`0.0.0.0`) and IPv6 (`::`) unspecified addresses mean
 * "all interfaces".
 */
const isUnspecified = (h: string) => h === "0.0.0.0" || h === "::";

function useJson(json: LogListenInfoOptions["json"]): boolean {
	if (json === "auto") {
		try {
			return !Deno.stdout.isTerminal();
		} catch {
			// stdout not inspectable (closed/redirected oddly) - assume "not a tty"
			return true;
		}
	}
	return !!json;
}

/**
 * Console logging callback for `Deno.serve()`'s `onListen` option.
 *
 * Prints the server's listening URL(s) to the console with color formatting.
 * When the hostname is `0.0.0.0` (or `::`, all interfaces), it displays both the
 * local (`localhost`) URL and all detected network interface addresses.
 * Otherwise, it prints the single bound address.
 *
 * With `{ json: true }` it instead emits a single structured JSON line on stdout
 * (see {@linkcode LogListenInfoOptions}), suitable for log collectors:
 *
 * ```json
 * {"timestamp":"2026-09-13T10:11:12.000Z","level":"info","logger":"demino",
 *  "message":"Demino listening: http://localhost:8000/","event":"server.listen",
 *  "hostname":"0.0.0.0","port":8000,"url":"http://localhost:8000/"}
 * ```
 *
 * Note that JSON mode does **not** enumerate network interfaces (container local
 * addresses are noise, and it avoids the `--allow-sys` permission).
 *
 * @param localAddr - The address the server is listening on
 * @param options - Optional output options
 *
 * @example Basic usage with `Deno.serve()`
 * ```ts
 * import { logListenInfo } from "@marianmeres/demino";
 *
 * Deno.serve({ onListen: logListenInfo }, handler);
 * ```
 *
 * @example With `deminoCompose()` and environment-based config
 * ```ts
 * import { deminoCompose, logListenInfo } from "@marianmeres/demino";
 *
 * Deno.serve(
 *   {
 *     port: parseInt(Deno.env.get("SERVER_PORT") || "") || undefined,
 *     hostname: Deno.env.get("SERVER_HOST") || undefined,
 *     onListen: logListenInfo,
 *   },
 *   deminoCompose([app1, app2]),
 * );
 * ```
 *
 * @example Structured JSON output (docker/production)
 * ```ts
 * import { createLogListenInfo } from "@marianmeres/demino";
 *
 * Deno.serve({
 *   onListen: createLogListenInfo({ json: "auto", fields: { service: "api" } }),
 * }, handler);
 * ```
 */
export function logListenInfo(
	localAddr: Deno.NetAddr,
	options?: LogListenInfoOptions,
) {
	const { hostname, port } = localAddr;
	const protocol = "http";

	if (useJson(options?.json)) {
		const url = `${protocol}://${
			isUnspecified(hostname) ? "localhost" : fmtHost(hostname)
		}:${port}/`;
		const out = options?.write ?? console.log;
		out(JSON.stringify({
			timestamp: new Date().toISOString(),
			level: "info",
			logger: options?.namespace ?? "demino",
			message: `Demino listening: ${url}`,
			event: "server.listen",
			hostname,
			port,
			url,
			...options?.fields,
		}));
		return;
	}

	// `%c` style directives are only meaningful for `console.log` - a custom sink
	// gets the plain text instead.
	const write = options?.write;
	const out = write
		? (msg: string, ..._styles: string[]) => write(msg.replaceAll("%c", ""))
		: console.log;

	if (isUnspecified(hostname)) {
		out("\n ✅ %cDemino listening:", "color:green;");
		out(
			`    ➜  Local:   %c${protocol}://localhost:${port}/`,
			"color:cyan;",
		);

		let interfaces: Deno.NetworkInterfaceInfo[] = [];
		try {
			interfaces = Deno.networkInterfaces();
		} catch {
			// needs `--allow-sys=networkInterfaces` - without it, silently skip the
			// network addresses (the local URL above is still printed)
		}
		for (const iface of interfaces) {
			const isV4 = iface.family === "IPv4" && !iface.address.startsWith("127.");
			// Skip IPv6 loopback (`::1`) and link-local (`fe80::…`, needs a zone id
			// to be usable) — only advertise routable IPv6 addresses.
			const isV6 = iface.family === "IPv6" &&
				iface.address !== "::1" &&
				!iface.address.toLowerCase().startsWith("fe80:");
			if (isV4 || isV6) {
				out(
					`    ➜  Network: %c${protocol}://${fmtHost(iface.address)}:${port}/`,
					"color:cyan;",
				);
			}
		}
	} else {
		out(
			`\n ✅ %cDemino listening: %c${protocol}://${fmtHost(hostname)}:${port}/`,
			"color:green;",
			"color:cyan;",
		);
	}
	out("");
}

/**
 * Creates a preconfigured {@linkcode logListenInfo} callback, so options can be
 * passed where `Deno.serve()` expects a bare `onListen` function.
 *
 * @param options - Output options (see {@linkcode LogListenInfoOptions})
 * @returns An `onListen` compatible callback
 *
 * @example
 * ```ts
 * import { createLogListenInfo } from "@marianmeres/demino";
 *
 * // human output locally, single JSON line when running in docker
 * Deno.serve({
 *   onListen: createLogListenInfo({
 *     json: "auto",
 *     fields: { service: "api", env: Deno.env.get("ENV") },
 *   }),
 * }, app);
 * ```
 */
export function createLogListenInfo(
	options?: LogListenInfoOptions,
): (localAddr: Deno.NetAddr) => void {
	return (localAddr: Deno.NetAddr) => logListenInfo(localAddr, options);
}
