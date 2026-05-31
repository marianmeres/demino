import { assert, assertEquals } from "@std/assert";
import { type Demino, demino, DEMINO_SORT, type DeminoHandler } from "../src/demino.ts";
import { assertResp, startTestServer } from "./_utils.ts";

type Srv = Awaited<ReturnType<typeof startTestServer>>;

async function withServer(app: Demino, fn: (base: string) => Promise<void>) {
	let srv: Srv | null = null;
	try {
		app.logger(null);
		srv = await startTestServer(app);
		await fn(srv.base);
	} finally {
		srv?.ac?.abort();
		await srv?.server?.finished;
	}
}

Deno.test("DEMINO_SORT: exposes the expected coordinate values", () => {
	assertEquals(DEMINO_SORT.PRE, 100);
	assertEquals(DEMINO_SORT.DEFAULT, 1000);
	assertEquals(DEMINO_SORT.HANDLER, Infinity);
	assert(DEMINO_SORT.PRE < DEMINO_SORT.DEFAULT);
	assert(DEMINO_SORT.DEFAULT < DEMINO_SORT.HANDLER);
});

Deno.test("DEMINO_SORT.PRE: a tagged middleware runs before a default one", async () => {
	const log: string[] = [];

	// registered AFTER the default mw, but tagged PRE -> must still run first
	const gate: DeminoHandler = () => {
		log.push("gate");
	};
	gate.__midwarePreExecuteSortOrder = DEMINO_SORT.PRE;

	const normal: DeminoHandler = () => {
		log.push("normal");
	};

	const app = demino();
	app.use(normal); // default order (DEMINO_SORT.DEFAULT)
	app.use(gate); // PRE -> sorts ahead despite later registration
	app.get("/", () => log.join(","));

	await withServer(app, async (base) => {
		await assertResp(fetch(`${base}/`), 200, "gate,normal");
	});
});
