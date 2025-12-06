import { demino } from "../../src/demino.ts";
import { DeminoExpressLikeRouter } from "../../src/router/express-like-router.ts";
import { assertResp, startTestServer } from "../_utils.ts";

type Srv = Awaited<ReturnType<typeof startTestServer>>;

Deno.test("express like router", async () => {
	let srv: Srv | null = null;

	const app = demino("", [], {
		routerFactory: () => new DeminoExpressLikeRouter(),
	});

	app.get("/", () => "home");
	app.get("/foo", () => "foo");
	app.get("/user/:foo/section/:baz", (_r, _i, ctx) => ctx.params);

	try {
		srv = await startTestServer(app);

		await assertResp(fetch(`${srv.base}`), 200, "home");
		await assertResp(fetch(`${srv.base}/foo`), 200, "foo");
		await assertResp(fetch(`${srv.base}/user/bar/section/bat`), 200, {
			foo: "bar",
			baz: "bat",
		});
		await assertResp(fetch(`${srv.base}/user/bar`), 404);
		await assertResp(fetch(`${srv.base}/user/bar/section`), 404);
		await assertResp(fetch(`${srv.base}/asdf`), 404);
	} catch (e) {
		throw e;
	} finally {
		srv?.ac?.abort();
	}

	return srv?.server?.finished;
});
