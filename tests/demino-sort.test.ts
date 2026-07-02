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

Deno.test(
	"sort order does not leak across routes when a handler fn is reused (regression)",
	async () => {
		// `shared` is the terminal handler on /health AND an early middleware on
		// /page. Demino must derive each function's order per assembly, not stamp it
		// onto the shared function object — otherwise /health pinning it to HANDLER
		// (Infinity) reorders /page's chain, and the outcome depends on which route
		// is hit first.
		const shared: DeminoHandler = (_r, _i, ctx) => {
			(ctx.locals.o ??= [] as string[]) as string[];
			(ctx.locals.o as string[]).push("shared");
		};
		const late: DeminoHandler = (_r, _i, ctx) => {
			(ctx.locals.o as string[]).push("late");
		};
		late.__midwarePreExecuteSortOrder = 2000; // after DEFAULT (1000)

		const app = demino();
		app.get("/health", shared); // shared as the final handler here
		app.get(
			"/page",
			shared, // early middleware -> must still run before `late`
			late,
			(_r, _i, ctx) => (ctx.locals.o as string[]).join(","),
		);

		await withServer(app, async (base) => {
			// Hit /health FIRST so a buggy impl pins `shared` to HANDLER (Infinity).
			// (`shared` returns undefined as the terminal handler here -> 204.)
			await assertResp(fetch(`${base}/health`), 204);
			// /page must still run shared before late, regardless of /health.
			await assertResp(fetch(`${base}/page`), 200, "shared,late");
			// order must be stable no matter the dispatch order.
			await assertResp(fetch(`${base}/page`), 200, "shared,late");
		});

		// the shared function object must NOT have been mutated by the framework
		assertEquals(shared.__midwarePreExecuteSortOrder, undefined);
	},
);
