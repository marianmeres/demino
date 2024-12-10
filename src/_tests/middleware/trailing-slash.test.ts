// deno-lint-ignore-file no-explicit-any

import { HTTP_STATUS } from "@marianmeres/http-utils";
import { assertEquals } from "@std/assert";
import { demino } from "../../demino.ts";
import { createTrailingSlash } from "../../middleware/trailing-slash.ts";
import { assertResp, startTestServer } from "../_utils.ts";

type Srv = Awaited<ReturnType<typeof startTestServer>>;

Deno.test("trailing slash manual redirect check", async () => {
	let srv: Srv | null = null;

	try {
		const tsOn = createTrailingSlash(true);
		const tsOff = createTrailingSlash(false);

		const globalMwOutput =
			"this must not be reached (tsMw will be executed earlier)";
		const app = demino();
		app.use(() => globalMwOutput);
		app.get("/foo/bar", tsOn, () => "foo");
		app.get("/baz/bat", tsOff, () => "baz");

		// root must be ignored
		app.get("/", tsOff, () => "home");

		srv = await startTestServer(app);

		// ON
		await assertResp(
			fetch(`${srv.base}/foo/bar`, { redirect: "manual" }),
			HTTP_STATUS.MOVED_PERMANENTLY,
			"",
			{ location: /\/$/ }
		);

		// OFF
		await assertResp(
			fetch(`${srv.base}/baz/bat/`, { redirect: "manual" }),
			HTTP_STATUS.MOVED_PERMANENTLY,
			"",
			{ location: /[^\/]$/ }
		);

		// NO-OP (it's correct that the global ms is reached here)
		await assertResp(
			fetch(`${srv.base}`, { redirect: "manual" }),
			200,
			globalMwOutput
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

	const _log: string[] = [];
	const logger = (v: string) => _log.push(v);
	try {
		const tsOn = createTrailingSlash(true, { logger });
		const tsOff = createTrailingSlash(false, { logger });

		const app = demino();
		app.get("/foo/bar", tsOn, () => "foo");
		app.get("/baz/bat", tsOff, () => "baz");

		srv = await startTestServer(app);

		// ON
		await assertResp(fetch(`${srv.base}/foo/bar`), 200, "foo");
		await assertResp(fetch(`${srv.base}/foo/bar/`), 200, "foo"); // no-op

		// OFF
		await assertResp(fetch(`${srv.base}/baz/bat/`), 200, "baz");
		await assertResp(fetch(`${srv.base}/baz/bat`), 200, "baz"); // no-op

		// the above 4 fetches must have triggered exactly 2 redirects (2 were no-ops)
		assertEquals(_log.length, 2);
	} catch (e) {
		throw e;
	} finally {
		srv?.ac?.abort();
	}

	return srv?.server?.finished;
});
