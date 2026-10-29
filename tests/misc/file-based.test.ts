import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { demino } from "../../src/demino.ts";
import { deminoFileBased, routesCompare } from "../../src/misc/file-based.ts";
import { assertResp, runTestServerTests } from "../_utils.ts";

// absolute
const _dirname = dirname(fileURLToPath(import.meta.url));
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
			assert.equal(routes.toSorted(routesCompare).join(), "/x,/y,/z,/[x]");

			routes = ["/a/z", "/a/y", "/a/[x]", "/a/x"];
			assert.equal(routes.toSorted(routesCompare).join(), "/a/x,/a/y,/a/z,/a/[x]");

			routes = ["/z", "/y", "/[x]", "/x", "/x/y", "/x/y/z"];
			assert.equal(
				routes.toSorted(routesCompare).join(),
				"/x/y/z,/x/y,/x,/y,/z,/[x]",
			);
		},
		raw: true,
	},
	{
		name: "missing root dir throws NotFound (ENOENT) by default",
		raw: true,
		fn: async () => {
			const app = demino();
			app.logger(null);
			const err = await deminoFileBased(app, "./__demino_does_not_exist__", {
				verbose: false,
			}).then(
				() => assert.fail("expected deminoFileBased to reject"),
				(e: unknown) => e as Error,
			);
			// the portable contract: a *plain* Error (no runtime-specific class) that
			// carries `name: "NotFound"` and the fs-style `code: "ENOENT"`
			assert.ok(
				Object.getPrototypeOf(err) === Error.prototype,
				`expected a plain Error, got ${err.constructor.name}`,
			);
			assert.equal(err.name, "NotFound");
			assert.equal((err as { code?: string }).code, "ENOENT");
			assert.match(err.message, /does not exist/i);
			assert.match(err.message, /__demino_does_not_exist__/);
		},
	},
	{
		name: "verbose walk lists route files in deterministic (sorted) path order",
		raw: true,
		fn: async () => {
			const app = demino();
			app.logger(null);
			const debug: string[] = [];
			// deno-lint-ignore no-explicit-any
			const logger: any = {
				debug: (...a: unknown[]) => debug.push(a.join(" ")),
				log() {},
				warn() {},
				error() {},
			};
			await deminoFileBased(app, root2, { verbose: true, logger });

			// the file lines are the ones carrying a fixture path (strip ANSI first)
			// deno-lint-ignore no-control-regex
			const files = debug
				.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""))
				.filter((l) => l.includes("_root2/"));
			const expected = [
				"tests/fixtures/_root2/_middleware.ts",
				"tests/fixtures/_root2/c/_middleware.ts",
				"tests/fixtures/_root2/c/d/_middleware.ts",
				"tests/fixtures/_root2/c/d/index.ts",
				"tests/fixtures/_root2/index.ts",
			];
			assert.deepEqual(files, expected);
			// ...and the dotfile in that dir (.DS_Store) never shows up
			assert.ok(!debug.some((l) => l.includes(".DS_Store")));
		},
	},
	{
		name: "ignoreMissingRootDir skips a missing dir (no throw, warns)",
		raw: true,
		fn: async () => {
			const app = demino();
			app.logger(null);
			const warnings: string[] = [];
			// deno-lint-ignore no-explicit-any
			const logger: any = {
				debug() {},
				log() {},
				error() {},
				warn: (...a: unknown[]) => warnings.push(a.join(" ")),
			};

			// real dir + a missing one — must not throw
			await deminoFileBased(app, [root1, "./__demino_missing__"], {
				verbose: false,
				ignoreMissingRootDir: true,
				logger,
			});

			// warned about the missing one...
			assert.ok(
				warnings.some((w) => /__demino_missing__/.test(w)),
				`expected a warning mentioning the missing dir, got: ${JSON.stringify(
					warnings,
				)}`,
			);
			// ...and routes from the real dir were still registered
			assert.ok(app.routes().length > 0, "expected routes from the real root dir");
		},
	},
	{
		name: "root that is a file (not a dir) always throws, even with ignore flag",
		raw: true,
		fn: async () => {
			const app = demino();
			app.logger(null);
			// point at this very test file — exists, but is not a directory
			const notADir = join(_dirname, "file-based.test.ts");
			await assert.rejects(
				() =>
					deminoFileBased(app, notADir, {
						verbose: false,
						ignoreMissingRootDir: true,
					}),
				{ name: "TypeError", message: /is not a directory/ },
			);
		},
	},
]);

test("deminoFileBased: a trailing slash in rootDir still registers routes", async () => {
	// A trailing separator used to survive `normalize` and then eat the leading "/"
	// of every derived route, silently producing a zero-route app. It must behave
	// exactly like the no-trailing-slash form.
	const app = demino();
	app.logger(null);
	await deminoFileBased(app, root1 + "/", { verbose: false });

	const routes = app.routes().map((r) => r.route);
	assert.ok(routes.length > 0, "expected routes to be registered");
	assert.ok(
		routes.every((r) => r.startsWith("/")),
		`every route must start with "/", got: ${routes.join(", ")}`,
	);
	assert.ok(
		routes.includes("/a"),
		`expected "/a" among routes, got: ${routes.join(", ")}`,
	);
});
