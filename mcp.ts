import { z } from "npm:zod";
import type { McpToolDefinition } from "@marianmeres/mcp-server/types";
import { isPrivateHost, isHostAllowed } from "./src/middleware/proxy/utils.ts";
import {
	serializeCookie,
	parseCookies,
	type CookieOptions,
} from "./src/utils/cookies.ts";

export const tools: McpToolDefinition[] = [
	{
		name: "generate-demino-app",
		description:
			"Generate boilerplate TypeScript code for a Demino web app with routes, middleware, and optional multi-app composition",
		params: {
			mountPath: z
				.string()
				.optional()
				.describe(
					'Base mount path (e.g., "/api"). Empty string for root',
				),
			routes: z
				.array(
					z.object({
						method: z
							.enum([
								"get",
								"post",
								"put",
								"patch",
								"delete",
								"all",
							])
							.describe("HTTP method"),
						path: z
							.string()
							.describe('Route path (e.g., "/users/[id]")'),
						description: z
							.string()
							.optional()
							.describe(
								"What this route does (becomes a comment)",
							),
					}),
				)
				.optional()
				.describe("Routes to generate"),
			middleware: z
				.array(
					z.enum([
						"cors",
						"cookies",
						"rateLimit",
						"trailingSlash",
						"etag",
					]),
				)
				.optional()
				.describe("Built-in middleware to include"),
			compose: z
				.boolean()
				.optional()
				.describe(
					"Generate deminoCompose() setup for multi-app composition",
				),
			fileBased: z
				.boolean()
				.optional()
				.describe("Include file-based routing setup"),
		},
		handler: async (args: Record<string, unknown>) => {
			const mountPath = args.mountPath as string | undefined;
			const routes = args.routes as
				| { method: string; path: string; description?: string }[]
				| undefined;
			const middleware = args.middleware as string[] | undefined;
			const compose = args.compose as boolean | undefined;
			const fileBased = args.fileBased as boolean | undefined;

			const imports: string[] = [
				'import { demino } from "jsr:@marianmeres/demino";',
			];
			const mwImports: string[] = [];
			const mwSetup: string[] = [];
			const routeLines: string[] = [];

			if (middleware?.includes("cors")) {
				mwImports.push("cors");
				mwSetup.push("app.use(cors());");
			}
			if (middleware?.includes("cookies")) {
				mwImports.push("cookies");
				mwSetup.push("app.use(cookies());");
			}
			if (middleware?.includes("rateLimit")) {
				mwImports.push("rateLimit");
				mwSetup.push(
					'app.use(rateLimit((req) => req.headers.get("x-forwarded-for") || "unknown"));',
				);
			}
			if (middleware?.includes("trailingSlash")) {
				mwImports.push("trailingSlash");
				mwSetup.push("app.use(trailingSlash(false));");
			}

			if (mwImports.length) {
				imports.push(
					`import { ${mwImports.join(", ")} } from "jsr:@marianmeres/demino/middleware";`,
				);
			}

			const miscImports: string[] = [];
			if (compose) miscImports.push("deminoCompose");
			if (fileBased) miscImports.push("deminoFileBased");
			if (miscImports.length) {
				imports.push(
					`import { ${miscImports.join(", ")} } from "jsr:@marianmeres/demino/misc";`,
				);
			}

			for (const route of routes || []) {
				const comment = route.description
					? `// ${route.description}\n`
					: "";
				routeLines.push(
					`${comment}app.${route.method}("${route.path}", (req, info, ctx) => {\n\t// TODO: implement\n\treturn { ok: true };\n});`,
				);
			}

			const mp = mountPath ? `"${mountPath}"` : "";
			let code = `${imports.join("\n")}\n\nconst app = demino(${mp});\n\n`;
			if (mwSetup.length) code += mwSetup.join("\n") + "\n\n";
			if (fileBased)
				code += 'await deminoFileBased(app, "./routes");\n\n';
			if (routeLines.length)
				code += routeLines.join("\n\n") + "\n\n";

			if (compose) {
				code += "Deno.serve(deminoCompose([app]));\n";
			} else {
				code += "Deno.serve(app);\n";
			}

			return code;
		},
	},
	{
		name: "serialize-cookie",
		description:
			"Serialize a cookie name/value pair with options into a Set-Cookie header string for use in HTTP responses",
		params: {
			name: z.string().describe("Cookie name"),
			value: z.string().describe("Cookie value"),
			maxAge: z.number().optional().describe("Max age in seconds"),
			path: z.string().optional().describe("Cookie path"),
			domain: z.string().optional().describe("Cookie domain"),
			secure: z
				.boolean()
				.optional()
				.describe("Only send over HTTPS"),
			httpOnly: z
				.boolean()
				.optional()
				.describe("Prevent JavaScript access"),
			sameSite: z
				.enum(["Strict", "Lax", "None"])
				.optional()
				.describe("SameSite attribute"),
		},
		handler: async (args: Record<string, unknown>) => {
			const name = args.name as string;
			const value = args.value as string;
			const options: CookieOptions = {};
			if (args.maxAge != null) options.maxAge = args.maxAge as number;
			if (args.path != null) options.path = args.path as string;
			if (args.domain != null) options.domain = args.domain as string;
			if (args.secure != null) options.secure = args.secure as boolean;
			if (args.httpOnly != null)
				options.httpOnly = args.httpOnly as boolean;
			if (args.sameSite != null)
				options.sameSite = args.sameSite as
					| "Strict"
					| "Lax"
					| "None";
			return serializeCookie(name, value, options);
		},
	},
	{
		name: "parse-cookies",
		description:
			"Parse a raw Cookie header string into key-value pairs (e.g., 'foo=bar; baz=qux' -> {foo: 'bar', baz: 'qux'})",
		params: {
			cookieHeader: z
				.string()
				.describe(
					'Raw Cookie header string (e.g., "foo=bar; baz=qux")',
				),
		},
		handler: async (args: Record<string, unknown>) => {
			return JSON.stringify(parseCookies(args.cookieHeader as string));
		},
	},
	{
		name: "check-private-host",
		description:
			"Check if a hostname or IP address is a private/internal address (SSRF protection). Detects localhost, private IPv4/IPv6 ranges.",
		params: {
			hostname: z
				.string()
				.describe("Hostname or IP address to check"),
		},
		handler: async (args: Record<string, unknown>) => {
			const hostname = args.hostname as string;
			return JSON.stringify({
				hostname,
				isPrivate: isPrivateHost(hostname),
			});
		},
	},
	{
		name: "check-host-allowed",
		description:
			'Validate a hostname against a whitelist with wildcard subdomain support (e.g., "*.example.com")',
		params: {
			hostname: z.string().describe("Hostname to validate"),
			allowedHosts: z
				.array(z.string())
				.describe(
					'Whitelist of allowed hosts, supports wildcards like "*.example.com"',
				),
		},
		handler: async (args: Record<string, unknown>) => {
			const hostname = args.hostname as string;
			const allowedHosts = args.allowedHosts as string[];
			return JSON.stringify({
				hostname,
				allowedHosts,
				isAllowed: isHostAllowed(hostname, allowedHosts),
			});
		},
	},
];
