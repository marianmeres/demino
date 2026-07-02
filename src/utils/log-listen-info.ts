/**
 * Console logging callback for `Deno.serve()`'s `onListen` option.
 *
 * Prints the server's listening URL(s) to the console with color formatting.
 * When the hostname is `0.0.0.0` (all interfaces), it displays both the local
 * (`localhost`) URL and all detected IPv4 network interface addresses. Otherwise,
 * it prints the single bound address.
 *
 * @param localAddr - The address the server is listening on
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
 */
export function logListenInfo(localAddr: Deno.NetAddr) {
	const { hostname, port } = localAddr;
	const protocol = "http";

	// IPv6 literals must be bracketed in a URL authority (`http://[::1]:8000/`).
	const fmtHost = (h: string) => (h.includes(":") ? `[${h}]` : h);

	// Both the IPv4 (`0.0.0.0`) and IPv6 (`::`) unspecified addresses mean
	// "all interfaces" — enumerate the concrete addresses in both cases.
	if (hostname === "0.0.0.0" || hostname === "::") {
		console.log("\n ✅ %cDemino listening:", "color:green;");
		console.log(
			`    ➜  Local:   %c${protocol}://localhost:${port}/`,
			"color:cyan;",
		);

		const interfaces = Deno.networkInterfaces();
		for (const iface of interfaces) {
			const isV4 = iface.family === "IPv4" && !iface.address.startsWith("127.");
			// Skip IPv6 loopback (`::1`) and link-local (`fe80::…`, needs a zone id
			// to be usable) — only advertise routable IPv6 addresses.
			const isV6 = iface.family === "IPv6" &&
				iface.address !== "::1" &&
				!iface.address.toLowerCase().startsWith("fe80:");
			if (isV4 || isV6) {
				console.log(
					`    ➜  Network: %c${protocol}://${fmtHost(iface.address)}:${port}/`,
					"color:cyan;",
				);
			}
		}
	} else {
		console.log(
			`\n ✅ %cDemino listening: %c${protocol}://${fmtHost(hostname)}:${port}/`,
			"color:green;",
			"color:cyan;",
		);
	}
	console.log("");
}
