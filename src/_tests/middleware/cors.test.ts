import { HTTP_STATUS } from "@marianmeres/http-utils";
import { cors } from "../../mod.ts";
import { assertResp, runTestServerTests } from "../_utils.ts";

runTestServerTests([
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

			// now use default wildcard
			app.use(cors({ allowCredentials: true }));

			await assertResp(fetch(`${base}/`), 200, undefined, {
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Methods": true,
				"Access-Control-Allow-Headers": true,
				"Access-Control-Allow-Credentials": true,
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
					"Access-Control-Allow-Credentials": true,
					"Access-Control-Max-Age": true,
				},
			);
		},
	},
]);
