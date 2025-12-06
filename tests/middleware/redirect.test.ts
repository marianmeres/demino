import { redirect } from "../../src/middleware/redirect.ts";
import { assertResp, runTestServerTests } from "../_utils.ts";

runTestServerTests([
	{
		name: "proxy works",
		fn: async ({ app, base }) => {
			app.use("/old", redirect("/new"));

			app.get("/old", () => "old");
			app.get("/new", () => "new");

			await assertResp(fetch(`${base}/old`), 200, "new");
		},
	},
]);
