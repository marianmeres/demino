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

	if (hostname === "0.0.0.0") {
		console.log("\n ✅ %cDemino listening:", "color:green;");
		console.log(
			`    ➜  Local:   %c${protocol}://localhost:${port}/`,
			"color:cyan;",
		);

		const interfaces = Deno.networkInterfaces();
		for (const iface of interfaces) {
			if (iface.family === "IPv4" && !iface.address.startsWith("127.")) {
				console.log(
					`    ➜  Network: %c${protocol}://${iface.address}:${port}/`,
					"color:cyan;",
				);
			}
		}
	} else {
		console.log(
			`\n ✅ %cDemino listening: %c${protocol}://${hostname}:${port}/`,
			"color:green;",
			"color:cyan;",
		);
	}
	console.log("");
}
