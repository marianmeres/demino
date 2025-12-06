import { demino } from "../../src/demino.ts";
import { DeminoRegexRouter } from "../../src/router/regex-router.ts";
import { assertResp, startTestServer } from "../_utils.ts";

type Srv = Awaited<ReturnType<typeof startTestServer>>;

Deno.test("regex router", async () => {
	let srv: Srv | null = null;

	const app = demino("", [], {
		routerFactory: () => new DeminoRegexRouter(),
	});

	// named groups will be returned as params
	app.get("^/(?<year>\\d{4})$", (_r, _i, c) => c.params);
	app.get("^/(?<year>\\d{4})-(?<month>\\d{2})$", (_r, _i, c) => c.params);

	// fixed, no params
	app.get("^/$", () => "home");
	app.get("^/foo$", () => "foo");

	// catch all else
	app.get(".+", () => "any");

	try {
		srv = await startTestServer(app);

		await assertResp(fetch(`${srv.base}/2024`), 200, { year: "2024" });
		await assertResp(fetch(`${srv.base}/2024-12`), 200, {
			year: "2024",
			month: "12",
		});
		await assertResp(fetch(`${srv.base}`), 200, "home");
		await assertResp(fetch(`${srv.base}/foo`), 200, "foo");
		await assertResp(fetch(`${srv.base}/asdf`), 200, "any");
	} catch (e) {
		throw e;
	} finally {
		srv?.ac?.abort();
	}

	return srv?.server?.finished;
});
