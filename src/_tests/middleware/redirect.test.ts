// deno-lint-ignore-file no-explicit-any

import { demino } from "../../demino.ts";
import { redirect } from "../../middleware/redirect.ts";
import { assertResp, startTestServer } from "../_utils.ts";

type Srv = Awaited<ReturnType<typeof startTestServer>>;

Deno.test("proxy works", async () => {
	let srv: Srv | null = null;

	try {
		const app = demino();

		app.use("/old", redirect("/new"));

		app.get("/old", () => "old");
		app.get("/new", () => "new");

		srv = await startTestServer(app);
		await assertResp(fetch(`${srv.base}/old`), 200, "new");
	} catch (e) {
		throw e;
	} finally {
		srv?.ac?.abort();
	}

	return srv?.server?.finished;
});
