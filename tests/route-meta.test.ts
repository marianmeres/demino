import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
	type Demino,
	demino,
	type DeminoContext,
	type DeminoHandler,
	withMeta,
} from "../src/demino.ts";
import { deminoFileBased } from "../src/misc/file-based.ts";
import { assertResp, startTestServer } from "./_utils.ts";

type Srv = Awaited<ReturnType<typeof startTestServer>>;

/** DRY: spin a server, run, always clean up. */
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

Deno.test("routeMeta: global app.use middleware sees static handler meta", async () => {
	let seen: Readonly<Record<string, unknown>> | null = null;

	const app = demino();
	// global middleware runs FIRST in the stack; it must already see routeMeta.
	// This is the regression guard: if the stamping were moved to after middleware
	// execution, `seen` would be {} here and the assert below would fail.
	app.use((_r, _i, ctx: DeminoContext) => {
		seen = ctx.routeMeta;
	});
	app.get("/x", withMeta({ permission: "x:read" }, () => "ok"));

	await withServer(app, async (base) => {
		await assertResp(fetch(`${base}/x`), 200, "ok");
		assertEquals(seen, { permission: "x:read" });
	});
});

Deno.test("routeMeta: handler.meta set directly (no withMeta) is surfaced", async () => {
	let seen: Readonly<Record<string, unknown>> | null = null;
	const handler: DeminoHandler = () => "ok";
	handler.meta = { tag: "audit" };

	const app = demino();
	app.use((_r, _i, ctx) => {
		seen = ctx.routeMeta;
	});
	app.get("/x", handler);

	await withServer(app, async (base) => {
		await assertResp(fetch(`${base}/x`), 200, "ok");
		assertEquals(seen, { tag: "audit" });
	});
});

Deno.test("routeMeta: route with no meta yields a frozen empty object", async () => {
	let seen: Readonly<Record<string, unknown>> | null = null;

	const app = demino();
	app.use((_r, _i, ctx) => {
		seen = ctx.routeMeta;
	});
	app.get("/x", () => "ok");

	await withServer(app, async (base) => {
		await assertResp(fetch(`${base}/x`), 200, "ok");
		assertEquals(seen, {});
		assert(Object.isFrozen(seen), "routeMeta default must be frozen");
	});
});

Deno.test("routeMeta: is frozen and shared (===) across requests to same route", async () => {
	const seen: Array<Readonly<Record<string, unknown>>> = [];

	const app = demino();
	app.use((_r, _i, ctx) => {
		seen.push(ctx.routeMeta);
	});
	app.get("/x", withMeta({ a: 1 }, () => "ok"));

	await withServer(app, async (base) => {
		await assertResp(fetch(`${base}/x`), 200, "ok");
		await assertResp(fetch(`${base}/x`), 200, "ok");
		assertEquals(seen.length, 2);
		assert(Object.isFrozen(seen[0]), "routeMeta must be frozen");
		// cached per (method, route): same frozen object reused, not re-allocated
		assert(seen[0] === seen[1], "routeMeta should be the same cached instance");
	});
});

Deno.test("routeMeta: auto-HEAD inherits the GET handler's meta", async () => {
	let seen: Readonly<Record<string, unknown>> | null = null;

	const app = demino();
	app.use((_r, _i, ctx) => {
		seen = ctx.routeMeta;
	});
	app.get("/x", withMeta({ permission: "x:read" }, () => "ok"));

	await withServer(app, async (base) => {
		// HEAD is auto-served from the GET handler -> must inherit its meta
		await assertResp(fetch(`${base}/x`, { method: "HEAD" }), 200, "");
		assertEquals(seen, { permission: "x:read" });
	});
});

Deno.test("routeMeta: distinct per (method, route)", async () => {
	const seen: Record<string, unknown> = {};

	const app = demino();
	app.use((_r, _i, ctx) => {
		seen[`${ctx.route}`] = ctx.routeMeta;
	});
	app.get("/a", withMeta({ perm: "a" }, () => "a"));
	app.get("/b", withMeta({ perm: "b" }, () => "b"));
	app.get("/c", () => "c");

	await withServer(app, async (base) => {
		await assertResp(fetch(`${base}/a`), 200, "a");
		assertEquals(seen["/a"], { perm: "a" });
		await assertResp(fetch(`${base}/b`), 200, "b");
		assertEquals(seen["/b"], { perm: "b" });
		await assertResp(fetch(`${base}/c`), 200, "c");
		assertEquals(seen["/c"], {});
	});
});

Deno.test("routeMeta: handler is last positional arg (route-level mws don't shadow meta)", async () => {
	let seen: Readonly<Record<string, unknown>> | null = null;
	const mw: DeminoHandler = () => {}; // a route-level middleware, no meta

	const app = demino();
	app.use((_r, _i, ctx) => {
		seen = ctx.routeMeta;
	});
	// meta lives on the final handler; the preceding mw must not affect resolution
	app.get("/x", mw, withMeta({ permission: "x:read" }, () => "ok"));

	await withServer(app, async (base) => {
		await assertResp(fetch(`${base}/x`), 200, "ok");
		assertEquals(seen, { permission: "x:read" });
	});
});

Deno.test("routeMeta: works for file-based routes (meta on exported handler)", async () => {
	const _dirname = import.meta.dirname!;
	const root = join(_dirname, "./fixtures/_root_meta");

	const seen: Record<string, unknown> = {};
	const app = demino();
	app.use((_r, _i, ctx) => {
		seen[ctx.route] = ctx.routeMeta;
	});
	await deminoFileBased(app, [root], { verbose: false });

	await withServer(app, async (base) => {
		await assertResp(fetch(`${base}/`), 200);
		assertEquals(seen["/"], { permission: "home:read" });
	});
});

Deno.test("withMeta: merges and returns the same handler", () => {
	const h: DeminoHandler = () => "ok";
	const ret = withMeta({ a: 1 }, h);
	assert(ret === h, "withMeta must return the same handler reference");
	withMeta({ b: 2 }, h);
	assertEquals(h.meta, { a: 1, b: 2 });
});
