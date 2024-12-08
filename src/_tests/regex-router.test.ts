import { assertEquals } from "@std/assert";
import { demino } from "../demino.ts";
import { DeminoRegexRouter } from "../router/regex-router.ts";
import { startTestServer } from "./_utils.ts";

type Srv = Awaited<ReturnType<typeof startTestServer>>;

Deno.test("regex router", async () => {
	let srv: Srv | null = null;
	let resp: Response;

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

		resp = await fetch(`${srv.base}/2024`);
		assertEquals(resp.status, 200);
		assertEquals(JSON.parse(await resp.text()), { year: "2024" });

		resp = await fetch(`${srv.base}/2024-12`);
		assertEquals(resp.status, 200);
		assertEquals(JSON.parse(await resp.text()), { year: "2024", month: "12" });

		resp = await fetch(`${srv.base}`);
		assertEquals(resp.status, 200);
		assertEquals(await resp.text(), "home");

		resp = await fetch(`${srv.base}/foo`);
		assertEquals(resp.status, 200);
		assertEquals(await resp.text(), "foo");

		resp = await fetch(`${srv.base}/asdf`);
		assertEquals(resp.status, 200);
		assertEquals(await resp.text(), "any");
	} catch (e) {
		throw e;
	} finally {
		srv?.ac?.abort();
	}

	return srv?.server?.finished;
});
