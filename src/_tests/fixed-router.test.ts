import { assertEquals, assertMatch } from "@std/assert";
import { demino } from "../demino.ts";
import { DeminoFixedRouter } from "../router/fixed-router.ts";
import { startTestServer } from "./_utils.ts";

type Srv = Awaited<ReturnType<typeof startTestServer>>;

Deno.test("fixed router", async () => {
	let srv: Srv | null = null;
	let resp: Response;

	const app = demino("", [], {
		routerFactory: () => new DeminoFixedRouter(),
	});

	app.get("/", () => "home");
	app.get("/foo", () => "foo");
	app.get("/foo/", () => "foo/");

	try {
		srv = await startTestServer(app);

		resp = await fetch(`${srv.base}`);
		assertEquals(resp.status, 200);
		assertEquals(await resp.text(), "home");

		resp = await fetch(`${srv.base}/foo`);
		assertEquals(resp.status, 200);
		assertEquals(await resp.text(), "foo");

		resp = await fetch(`${srv.base}/foo/`);
		assertEquals(resp.status, 200);
		assertEquals(await resp.text(), "foo/");

		resp = await fetch(`${srv.base}/asdf`);
		assertEquals(resp.status, 404);
		assertMatch(await resp.text(), /not found/i);
	} catch (e) {
		throw e;
	} finally {
		srv?.ac?.abort();
	}

	return srv?.server?.finished;
});
