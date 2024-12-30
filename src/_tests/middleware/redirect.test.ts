// deno-lint-ignore-file no-explicit-any

import { redirect } from "../../middleware/redirect.ts";
import {
	assertResp,
	runTestServerTests,
	type TestServerTestsParams,
} from "../_utils.ts";

runTestServerTests([
	{
		name: "proxy works",
		fn: async ({ app, base }: TestServerTestsParams) => {
			app.use("/old", redirect("/new"));

			app.get("/old", () => "old");
			app.get("/new", () => "new");

			await assertResp(fetch(`${base}/old`), 200, "new");
		},
	},
]);
