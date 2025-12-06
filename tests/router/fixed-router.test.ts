import { demino } from "../../src/demino.ts";
import { DeminoFixedRouter } from "../../src/router/fixed-router.ts";
import { assertResp, startTestServer } from "../_utils.ts";

type Srv = Awaited<ReturnType<typeof startTestServer>>;

Deno.test("fixed router", async () => {
	let srv: Srv | null = null;

	const app = demino("", [], {
		routerFactory: () => new DeminoFixedRouter(),
	});

	app.get("/", () => "home");
	app.get("/foo", () => "foo");
	app.get("/foo/", () => "foo/");

	try {
		srv = await startTestServer(app);

		await assertResp(fetch(`${srv.base}`), 200, "home");
		await assertResp(fetch(`${srv.base}/foo`), 200, "foo");
		await assertResp(fetch(`${srv.base}/foo/`), 200, "foo/");
		await assertResp(fetch(`${srv.base}/asdf`), 404);
	} catch (e) {
		throw e;
	} finally {
		srv?.ac?.abort();
	}

	return srv?.server?.finished;
});
