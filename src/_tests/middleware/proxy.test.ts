// deno-lint-ignore-file no-explicit-any

import { serveFile } from "@std/http/file-server";
import { demino } from "../../demino.ts";
import { proxy } from "../../middleware/proxy.ts";
import { assertResp, startTestServer } from "../_utils.ts";
import { sleep } from "@marianmeres/midware";

type Srv = Awaited<ReturnType<typeof startTestServer>>;

Deno.test("proxy works", async () => {
	let srv: Srv | null = null;

	try {
		const app = demino();
		app.get("/a", () => "a");
		app.get("/b", (r) => new URL(r.url).search);
		app.get("/c", proxy({ target: "/d" }));
		app.get("/d", () => "d");
		app.get("/file", (req) => serveFile(req, "./src/_tests/static/foo.txt"));

		app.get("/to-self", proxy({ target: "/to-self" })); // will throw

		const _sleepTimer = { id: -1 };
		app.get("/slow", async () => {
			await sleep(100, _sleepTimer);
			return "woke up";
		});

		app.get("/xa", proxy({ target: "/a" }));
		app.get("/xb", proxy({ target: "/b" }));
		app.get("/xc", proxy({ target: "/c" }));
		app.get("/xfile", proxy({ target: "/file" }));

		app.get("/xslow", proxy({ target: "/slow", timeout: 20 }));

		srv = await startTestServer(app);
		const { base } = srv;

		await assertResp(fetch(`${base}/xa`), 200, "a");
		await assertResp(fetch(`${base}/xb?foo=bar`), 200, "?foo=bar");
		await assertResp(fetch(`${base}/xc`), 200, "d"); // not c!
		await assertResp(fetch(`${base}/to-self`), 500, /proxy to self/i);
		await assertResp(fetch(`${base}/xfile`), 200, "foo");

		await assertResp(fetch(`${base}/xslow`), 500, /timed out/i);
		clearTimeout(_sleepTimer.id);

		// target as full url
		app.get("/full", proxy({ target: `${base}/d` }));
		await assertResp(fetch(`${base}/full`), 200, "d");

		// relative target
		app.get("/a/b", () => "/a/b");
		app.get("/a/b/c/d", proxy({ target: "../" }));
		await assertResp(fetch(`${base}/a/b/c/d`), 200, "/a/b");
	} catch (e) {
		throw e;
	} finally {
		srv?.ac?.abort();
	}

	return srv?.server?.finished;
});
