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
	blog.get("/", (_r, _i, _c) => `Blog root`);
	blog.get("/[slug]", (_r, _i, ctx) => `Blog: ${ctx.params.slug}`);

	// mounted "inside" of another - must win over /blog/[slug]
	const special = demino("/blog/special");
	special.get("/", (_r, _i, _c) => `special`);
	special.get("/[slug]", (_r, _i, ctx) => `special: ${ctx.params.slug}`);

	const app = deminoCompose([home, api, blog, special]);

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

		// api root
		await assertResp(
			fetch(`${srv.base}/api`),
			200,
			{ hello: "world" },
			{ "content-type": /json/ }
		);

		await assertResp(fetch(`${srv.base}/blog`), 200, /Blog root/i);
		await assertResp(fetch(`${srv.base}/blog/`), 200, /Blog root/i);

		// homepage slug
		await assertResp(fetch(`${srv.base}/blog/hey`), 200, /Blog: hey/i, {
			"content-type": /text\/html/,
		});

		// deep nested
		await assertResp(fetch(`${srv.base}/blog/special`), 200, "special");
		await assertResp(fetch(`${srv.base}/blog/special/`), 200, "special");
		await assertResp(
			fetch(`${srv.base}/blog/special/foo`),
			200,
			/special: foo/i
		);
	} catch (e) {
		throw e;
	} finally {
		srv?.ac?.abort();
	}

	return srv?.server?.finished;
});
