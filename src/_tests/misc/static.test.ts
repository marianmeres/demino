import { join } from "@std/path";
import { demino } from "../../demino.ts";
import { assertResp, startTestServer } from "../_utils.ts";

type Srv = Awaited<ReturnType<typeof startTestServer>>;

Deno.test("serve static on root", async () => {
	let srv: Srv | null = null;

	// landing page example
	const app = demino();
	app.static("/", join(import.meta.dirname!, "../static"));

	app.get("/hello", () => "world");

	try {
		srv = await startTestServer(app);

		await assertResp(fetch(`${srv.base}`), 200, /index/); // showIndex is true by default
		await assertResp(fetch(`${srv.base}/foo.txt`), 200, /foo/);
		await assertResp(fetch(`${srv.base}/foo`), 404);
		await assertResp(fetch(`${srv.base}/foo/bar/baz.txt`), 200, /baz/);
		await assertResp(fetch(`${srv.base}/hey/ho`), 404);
		await assertResp(fetch(`${srv.base}/hello`), 200, /world/);
	} catch (e) {
		throw e;
	} finally {
		srv?.ac?.abort();
	}

	return srv?.server?.finished;
});

Deno.test("serve static on route", async () => {
	let srv: Srv | null = null;

	// landing page example
	const app = demino();
	app.get("/", () => "hello");
	app.static("/files", join(import.meta.dirname!, "../static"));

	try {
		srv = await startTestServer(app);

		await assertResp(fetch(`${srv.base}`), 200, /hello/);
		await assertResp(fetch(`${srv.base}/files`), 200, /index/); // showIndex is true by default
		await assertResp(fetch(`${srv.base}/files/foo.txt`), 200, /foo/);
		await assertResp(fetch(`${srv.base}/files/foo`), 404);
		await assertResp(fetch(`${srv.base}/files/foo/bar/baz.txt`), 200, /baz/);
		await assertResp(fetch(`${srv.base}/files/hey/ho`), 404);
	} catch (e) {
		throw e;
	} finally {
		srv?.ac?.abort();
	}

	return srv?.server?.finished;
});

Deno.test("serve static on inner route", async () => {
	let srv: Srv | null = null;

	// landing page example
	const app = demino();
	app.get("/", () => "hello");
	app.static("/m/y/fil/es", join(import.meta.dirname!, "../static"));

	try {
		srv = await startTestServer(app);
		const { base } = srv;

		await assertResp(fetch(`${base}`), 200, /hello/);
		await assertResp(fetch(`${base}/m/y/fil/es`), 200, /index/); // showIndex is true by default
		await assertResp(fetch(`${base}/m/y/fil/es/foo`), 404);
		await assertResp(fetch(`${base}/m/y/fil/es/foo/bar/baz.txt`), 200, /baz/);
		await assertResp(fetch(`${base}/m/y/fil/es/hey/ho`), 404);
	} catch (e) {
		throw e;
	} finally {
		srv?.ac?.abort();
	}

	return srv?.server?.finished;
});
