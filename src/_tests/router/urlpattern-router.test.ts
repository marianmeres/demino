import { demino } from "../../demino.ts";
import { DeminoUrlPatternRouter } from "../../mod.ts";
import { assertResp, startTestServer } from "../_utils.ts";

type Srv = Awaited<ReturnType<typeof startTestServer>>;

Deno.test("urlpattern router", async () => {
	let srv: Srv | null = null;

	const app = demino("", [], {
		routerFactory: () => new DeminoUrlPatternRouter(),
	});

	app.get("/", () => "home");
	app.get("/books", () => "books");
	app.get("/books/:id", (_r, _i, ctx) => ctx.params);
	app.get("/user/:foo/section/:baz", (_r, _i, ctx) => ctx.params);

	try {
		srv = await startTestServer(app);

		await assertResp(fetch(`${srv.base}`), 200, "home");
		await assertResp(fetch(`${srv.base}/books`), 200, "books");
		await assertResp(fetch(`${srv.base}/books/foo`), 200, { id: "foo" });
		await assertResp(fetch(`${srv.base}/user/bar/section/bat`), 200, {
			foo: "bar",
			baz: "bat",
		});
		await assertResp(fetch(`${srv.base}/asdf`), 404);
	} catch (e) {
		throw e;
	} finally {
		srv?.ac?.abort();
	}

	return srv?.server?.finished;
});
