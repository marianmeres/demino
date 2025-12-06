import { assertEquals } from "@std/assert";
import { join, relative } from "@std/path";
import { deminoFileBased, routesCompare } from "../../src/misc/file-based.ts";
import { assertResp, runTestServerTests } from "../_utils.ts";

// absolute
const _dirname = import.meta.dirname!;
const root1 = join(_dirname, "../fixtures/_root1");
// const root2 = join(_dirname, "../fixtures/_root2");

// relative
// const root1 = "tests/fixtures/_root1";
const root2 = "./tests/fixtures/_root2";

runTestServerTests([
	{
		name: "file-based",
		fn: async ({ base, app }) => {
			// GET /a/b/c (1 mws)
			// GET /a/b (1 mws)
			// ALL /a/b (1 mws)
			// GET /c/d (2 mws)
			// GET /a (0 mws)
			// GET /[b] (0 mws)
			// GET / (1 mws)
			await deminoFileBased(app, [root1, root2], {
				verbose: false,
				doImport: (mod) => import(`./${relative(import.meta.dirname!, mod)}`),
			});

			// note that the root2 / middleware is taking affect in root1 as well, which is
			// expected

			// /a/b/c
			await assertResp(fetch(`${base}/a/b/c`), 200, "a/b/c|/,A/B");
			// /a/b
			await assertResp(fetch(`${base}/a/b`), 200, "a/b|/,A/B,self:A/B");
			await assertResp(
				fetch(`${base}/a/b`, { method: "POST" }),
				200,
				"ALL:a/b|/,A/B",
			); // root1
			// /c/d
			await assertResp(fetch(`${base}/c/d`), 200, "c/d|/,C,C/D,self:C/D"); // root2
			// /a
			await assertResp(fetch(`${base}/a`), 200, "a"); // root2
			// /[b]
			const rnd = Math.random();
			await assertResp(fetch(`${base}/${rnd}`), 200, { b: `${rnd}` }); // root1
			await assertResp(fetch(`${base}/_ignored`), 200, { b: `_ignored` }); // this is the [b] route
			// /
			await assertResp(fetch(`${base}`), 200, "/2|/"); // root2 (root1 is overwritten)

			//
			await assertResp(fetch(`${base}/a/b/c/d`), 404);
		},
	},
	{
		name: "routes specificity sorting works",
		fn: () => {
			let routes = ["/z", "/y", "/[x]", "/x"];
			assertEquals(routes.toSorted(routesCompare).join(), "/x,/y,/z,/[x]");

			routes = ["/a/z", "/a/y", "/a/[x]", "/a/x"];
			assertEquals(
				routes.toSorted(routesCompare).join(),
				"/a/x,/a/y,/a/z,/a/[x]",
			);

			routes = ["/z", "/y", "/[x]", "/x", "/x/y", "/x/y/z"];
			assertEquals(
				routes.toSorted(routesCompare).join(),
				"/x/y/z,/x/y,/x,/y,/z,/[x]",
			);
		},
		raw: true,
	},
]);
