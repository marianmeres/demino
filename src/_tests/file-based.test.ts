// deno-lint-ignore-file no-explicit-any

import { startTestServer } from "./_utils.ts";
import { assertEquals, assertMatch } from "@std/assert";
import { demino } from "../demino.ts";

import { dirname, join } from "@std/path";
import { deminoFileBased } from "../file-based.ts";

// const create = Deno.readTextFileSync(
// join(dirname(import.meta.filename!), "__schema-template__.sql"),
// );

const _dirname = dirname(import.meta.filename!);
const _rootDirs = [
	join(_dirname, "./_testdata/_root1"),
	join(_dirname, "./_testdata/_root2"),
];

type Srv = Awaited<ReturnType<typeof startTestServer>>;

Deno.test("file-based", async () => {
	let srv: Srv | null = null;

	const app = demino();

	try {
		srv = await startTestServer(app);

		// deminoFileBased(app, _rootDirs);

		// resp = await fetch(srv.base);
		// assertEquals(resp.status, 404);
		// assertMatch(await resp.text(), /not found/i);
	} catch (e) {
		throw e;
	} finally {
		srv?.ac?.abort();
	}

	return srv?.server?.finished;
});
