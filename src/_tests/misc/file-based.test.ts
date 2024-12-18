// deno-lint-ignore-file no-explicit-any

import { assertEquals } from "@std/assert";
import { demino } from "../../demino.ts";
import { assertResp, startTestServer } from "../_utils.ts";

import { dirname, join } from "@std/path";
import { deminoFileBased, routesCompare } from "../../misc/file-based.ts";

// const create = Deno.readTextFileSync(
// join(dirname(import.meta.filename!), "__schema-template__.sql"),
// );

const _dirname = dirname(import.meta.filename!);
const root1 = join(_dirname, "../fixtures/_root1");
const root2 = join(_dirname, "../fixtures/_root2");
const root3 = join(_dirname, "../fixtures/_root3");

type Srv = Awaited<ReturnType<typeof startTestServer>>;

Deno.test("file-based", async () => {
	let srv: Srv | null = null;

	try {
		const app = demino();
		srv = await startTestServer(app);

		// GET /a/b/c (1 mws)
		// GET /a/b (1 mws)
		// ALL /a/b (1 mws)
		// GET /c/d (2 mws)
		// GET /a (0 mws)
		// GET /[b] (0 mws)
		// GET / (1 mws)
		await deminoFileBased(app, [root1, root2], { verbose: false });

		// note that the root2 / middleware is taking affect in root1 as well, which is
		// expected

		// /a/b/c
		await assertResp(fetch(`${srv.base}/a/b/c`), 200, "a/b/c|/,A/B");
		// /a/b
		await assertResp(fetch(`${srv.base}/a/b`), 200, "a/b|/,A/B,self:A/B");
		await assertResp(
			fetch(`${srv.base}/a/b`, { method: "POST" }),
			200,
			"ALL:a/b|/,A/B"
		); // root1
		// /c/d
		await assertResp(fetch(`${srv.base}/c/d`), 200, "c/d|/,C,C/D,self:C/D"); // root2
		// /a
		await assertResp(fetch(`${srv.base}/a`), 200, "a"); // root2
		// /[b]
		const rnd = Math.random();
		await assertResp(fetch(`${srv.base}/${rnd}`), 200, { b: `${rnd}` }); // root1
		await assertResp(fetch(`${srv.base}/_ignored`), 200, { b: `_ignored` }); // this is the [b] route
		// /
		await assertResp(fetch(`${srv.base}/`), 200, "/2|/"); // root2 (root1 is overwritten)

		//
		await assertResp(fetch(`${srv.base}/a/b/c/d`), 404);
	} catch (e) {
		throw e;
	} finally {
		srv?.ac?.abort();
	}

	return srv?.server?.finished;
});

Deno.test("routes specificity sorting works", () => {
	let routes = ["/z", "/y", "/[x]", "/x"];
	assertEquals(routes.toSorted(routesCompare).join(), "/x,/y,/z,/[x]");

	routes = ["/a/z", "/a/y", "/a/[x]", "/a/x"];
	assertEquals(routes.toSorted(routesCompare).join(), "/a/x,/a/y,/a/z,/a/[x]");

	routes = ["/z", "/y", "/[x]", "/x", "/x/y", "/x/y/z"];
	assertEquals(
		routes.toSorted(routesCompare).join(),
		"/x/y/z,/x/y,/x,/y,/z,/[x]"
	);
});
