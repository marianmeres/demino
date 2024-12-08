import { demino } from "../../demino.ts";
import { createTrailingSlashMiddleware } from "../../middleware/trailing-slash.ts";
import { assertResp, startTestServer } from "../_utils.ts";

type Srv = Awaited<ReturnType<typeof startTestServer>>;

Deno.test("trailing slash manual redirect check", async () => {
	let srv: Srv | null = null;

	try {
		const tsOn = createTrailingSlashMiddleware({ strategy: "on" });
		const tsOff = createTrailingSlashMiddleware({ strategy: "off" });

		const app = demino();
		app.use(() => "this must not be reached because ts will be sorted earlier");
		app.get("/foo/bar", tsOn, () => "foo");
		app.get("/baz/bat", tsOff, () => "baz");

		srv = await startTestServer(app);

		// ON
		await assertResp(
			fetch(`${srv.base}/foo/bar`, { redirect: "manual" }),
			301,
			"",
			{ location: /\/$/ }
		);

		// OFF
		await assertResp(
			fetch(`${srv.base}/baz/bat/`, { redirect: "manual" }),
			301,
			"",
			{ location: /[^\/]$/ }
		);
	} catch (e) {
		throw e;
	} finally {
		srv?.ac?.abort();
	}

	return srv?.server?.finished;
});

Deno.test("trailing slash auto redirect", async () => {
	let srv: Srv | null = null;

	try {
		const tsOn = createTrailingSlashMiddleware({ strategy: "on" });
		const tsOff = createTrailingSlashMiddleware({ strategy: "off" });

		const app = demino();
		app.get("/foo/bar", tsOn, () => "foo");
		app.get("/baz/bat", tsOff, () => "baz");

		srv = await startTestServer(app);

		// ON
		await assertResp(fetch(`${srv.base}/foo/bar`), 200, "foo");
		await assertResp(fetch(`${srv.base}/foo/bar/`), 200, "foo");

		// OFF
		await assertResp(fetch(`${srv.base}/baz/bat/`), 200, "baz");
		await assertResp(fetch(`${srv.base}/baz/bat`), 200, "baz");
	} catch (e) {
		throw e;
	} finally {
		srv?.ac?.abort();
	}

	return srv?.server?.finished;
});
