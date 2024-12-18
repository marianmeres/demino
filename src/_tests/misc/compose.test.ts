import { demino } from "../../demino.ts";
import { deminoCompose } from "../../misc/compose.ts";
import { assertResp, startTestServer } from "../_utils.ts";

type Srv = Awaited<ReturnType<typeof startTestServer>>;

Deno.test("composition", async () => {
	let srv: Srv | null = null;

	// landing page example
	const home = demino();
	home.get("/", () => "Hello");
	home.get("/[slug]", (_r, _i, ctx) => `Marketing: ${ctx.params.slug}`);

	// api example
	const api = demino("/api", (_r, _i, ctx) => {
		ctx.headers.set("content-type", "application/json; charset=utf-8");
	});
	api.get("/", (_r, _i, _c) => ({ hello: "world" }));
	api.get("/[slug]", (_r, _i, ctx) => ({ api: ctx.params.slug }));

	// etc...
	const blog = demino("/blog");
	blog.get("/[slug]", (_r, _i, ctx) => `Blog: ${ctx.params.slug}`);

	const app = deminoCompose([home, api, blog]);

	try {
		srv = await startTestServer(app);

		// homepage
		await assertResp(fetch(`${srv.base}`), 200, /hello/i, {
			"content-type": /text\/html/,
		});

		// homepage slug
		await assertResp(fetch(`${srv.base}/foo`), 200, /Marketing: foo/i, {
			"content-type": /text\/html/,
		});

		// now, this is not api root, but homepage "api" slug
		await assertResp(fetch(`${srv.base}/api`), 200, /Marketing: api/i, {
			"content-type": /text\/html/,
		});

		// now this is api root
		await assertResp(
			fetch(`${srv.base}/api/`),
			200,
			{ hello: "world" },
			{ "content-type": /json/ }
		);

		// homepage slug
		await assertResp(fetch(`${srv.base}/blog/hey`), 200, /Blog: hey/i, {
			"content-type": /text\/html/,
		});
	} catch (e) {
		throw e;
	} finally {
		srv?.ac?.abort();
	}

	return srv?.server?.finished;
});
