import { join } from "@std/path";
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
	home.static("/files", join(import.meta.dirname!, "../static"));

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
	blog.static("/files", join(import.meta.dirname!, "../static"));

	// mounted "inside" of another - must win over /blog/[slug]
	const special = demino("/blog/special");
	special.get("/", (_r, _i, _c) => `special`);
	special.get("/[slug]", (_r, _i, ctx) => `special: ${ctx.params.slug}`);
	special.static("/files", join(import.meta.dirname!, "../static"));

	const app = deminoCompose([home, api, blog, special]);

	try {
		srv = await startTestServer(app);
		const { base } = srv;

		// homepage
		await assertResp(fetch(`${base}`), 200, /hello/i, {
			"content-type": /text\/html/,
		});

		// homepage slug
		await assertResp(fetch(`${base}/foo`), 200, /Marketing: foo/i, {
			"content-type": /text\/html/,
		});

		// api root
		await assertResp(
			fetch(`${base}/api`),
			200,
			{ hello: "world" },
			{ "content-type": /json/ },
		);

		await assertResp(fetch(`${base}/blog`), 200, /Blog root/i);

		// homepage slug
		await assertResp(fetch(`${base}/blog/hey`), 200, /Blog: hey/i);

		// deep nested
		await assertResp(fetch(`${base}/blog/special`), 200, "special");
		await assertResp(fetch(`${base}/blog/special/`), 200, "special");
		await assertResp(fetch(`${base}/blog/special/foo`), 200, /special: foo/i);

		await assertResp(fetch(`${base}/some/not/existing/`), 404);

		//
		await assertResp(fetch(`${base}/files/foo/bar/baz.txt`), 200, /baz/);
		await assertResp(fetch(`${base}/blog/files/foo/bar/baz.txt`), 200);
		await assertResp(fetch(`${base}/blog/special/files/foo/bar/baz.txt`), 200);
	} catch (e) {
		throw e;
	} finally {
		srv?.ac?.abort();
	}

	return srv?.server?.finished;
});
