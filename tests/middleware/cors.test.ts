import { HTTP_STATUS } from "@marianmeres/http-utils";
import { assertThrows } from "@std/assert";
import { cors } from "../../src/mod.ts";
import { assertResp, runTestServerTests } from "../_utils.ts";

Deno.test("cors() throws on wildcard origin + credentials true", () => {
	assertThrows(
		() => cors({ allowOrigin: "*", allowCredentials: true }),
		TypeError,
		"allowCredentials",
	);
});

Deno.test("cors() default config does NOT enable credentials", () => {
	// We can only assert it doesn't throw — the runtime behavior is covered
	// in the integration test below ("cors sanity check").
	cors();
});

runTestServerTests([
	{
		name: "cors: Vary: Origin is set even when the origin does not match (array)",
		fn: async ({ app, base }) => {
			app.use(cors({ allowOrigin: ["https://allowed.example"] }));
			app.get("/x", () => "ok");

			// non-allowed origin: no ACAO, but Vary: Origin MUST still be present so a
			// shared cache cannot reuse this response for a matching origin.
			await assertResp(
				fetch(`${base}/x`, { headers: { origin: "https://evil.example" } }),
				200,
				"ok",
				{ "Access-Control-Allow-Origin": false, Vary: /origin/i },
			);

			// matching origin: ACAO echoed, Vary: Origin present
			await assertResp(
				fetch(`${base}/x`, { headers: { origin: "https://allowed.example" } }),
				200,
				"ok",
				{
					"Access-Control-Allow-Origin": "https://allowed.example",
					Vary: /origin/i,
				},
			);
		},
	},
	{
		name: "cors sanity check",
		fn: async ({ app, base }) => {
			app.get("/", () => "");

			await assertResp(fetch(`${base}/`), 200, undefined, {
				"Access-Control-Allow-Origin": false,
				"Access-Control-Allow-Methods": false,
				"Access-Control-Allow-Headers": false,
				"Access-Control-Allow-Credentials": false,
				"Access-Control-Max-Age": false,
			});

			// now use default wildcard origin (credentials must stay false —
			// the wildcard + credentials combination is rejected as of 1.7.0).
			app.use(cors());

			await assertResp(fetch(`${base}/`), 200, undefined, {
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Methods": true,
				"Access-Control-Allow-Headers": true,
				"Access-Control-Allow-Credentials": false,
				"Access-Control-Max-Age": true,
			});
		},
	},
	{
		name: "dynamic resolve",
		fn: async ({ app, base }) => {
			app.get("/", () => "");

			app.get(
				"/withcors",
				cors({
					allowOrigin: (origin: string) => {
						if (origin.includes("hey.ho")) return origin;
						return "";
					},
				}),
				() => "",
			);

			const origin = "http://hey.ho";

			await assertResp(
				fetch(`${base}/`, { headers: { origin } }),
				200,
				undefined,
				{ "Access-Control-Allow-Origin": false },
			);

			await assertResp(
				fetch(`${base}/withcors`, { headers: { origin } }),
				200,
				undefined,
				{ "Access-Control-Allow-Origin": origin },
			);

			await assertResp(
				fetch(`${base}/withcors`, { headers: { origin: "http://bad" } }),
				200,
				undefined,
				{ "Access-Control-Allow-Origin": false },
			);
		},
	},
	{
		name: "options app wide",
		fn: async ({ app, base }) => {
			app.options("*", cors()); // must allow options explicitly
			// app.use(cors());

			app.get("/my/foo/bar", () => "baz");

			await assertResp(
				fetch(`${base}/`, { method: "OPTIONS" }),
				HTTP_STATUS.NO_CONTENT,
				undefined,
				{
					"Access-Control-Allow-Origin": "*",
					"Access-Control-Allow-Methods": true,
					"Access-Control-Allow-Headers": true,
					// `cors()` defaults to allowCredentials: false (since 1.7.0),
					// so this header is intentionally NOT set
					"Access-Control-Allow-Credentials": false,
					"Access-Control-Max-Age": true,
				},
			);
		},
	},
]);
