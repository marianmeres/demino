import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
		await srv?.close();
	}
}

test("routeMeta: global app.use middleware sees static handler meta", async () => {
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
		assert.deepEqual(seen, { permission: "x:read" });
	});
});

test("routeMeta: handler.meta set directly (no withMeta) is surfaced", async () => {
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
		assert.deepEqual(seen, { tag: "audit" });
	});
});

test("routeMeta: route with no meta yields a frozen empty object", async () => {
	let seen: Readonly<Record<string, unknown>> | null = null;

	const app = demino();
	app.use((_r, _i, ctx) => {
		seen = ctx.routeMeta;
	});
	app.get("/x", () => "ok");

	await withServer(app, async (base) => {
		await assertResp(fetch(`${base}/x`), 200, "ok");
		assert.deepEqual(seen, {});
		assert.ok(Object.isFrozen(seen), "routeMeta default must be frozen");
	});
});

test("routeMeta: is frozen and shared (===) across requests to same route", async () => {
	const seen: Array<Readonly<Record<string, unknown>>> = [];

	const app = demino();
	app.use((_r, _i, ctx) => {
		seen.push(ctx.routeMeta);
	});
	app.get("/x", withMeta({ a: 1 }, () => "ok"));

	await withServer(app, async (base) => {
		await assertResp(fetch(`${base}/x`), 200, "ok");
		await assertResp(fetch(`${base}/x`), 200, "ok");
		assert.equal(seen.length, 2);
		assert.ok(Object.isFrozen(seen[0]), "routeMeta must be frozen");
		// cached per (method, route): same frozen object reused, not re-allocated
		assert.ok(seen[0] === seen[1], "routeMeta should be the same cached instance");
	});
});

test("routeMeta: auto-HEAD inherits the GET handler's meta", async () => {
	let seen: Readonly<Record<string, unknown>> | null = null;

	const app = demino();
	app.use((_r, _i, ctx) => {
		seen = ctx.routeMeta;
	});
	app.get("/x", withMeta({ permission: "x:read" }, () => "ok"));

	await withServer(app, async (base) => {
		// HEAD is auto-served from the GET handler -> must inherit its meta
		await assertResp(fetch(`${base}/x`, { method: "HEAD" }), 200, "");
		assert.deepEqual(seen, { permission: "x:read" });
	});
});

test("routeMeta: distinct per (method, route)", async () => {
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
		assert.deepEqual(seen["/a"], { perm: "a" });
		await assertResp(fetch(`${base}/b`), 200, "b");
		assert.deepEqual(seen["/b"], { perm: "b" });
		await assertResp(fetch(`${base}/c`), 200, "c");
		assert.deepEqual(seen["/c"], {});
	});
});

test("routeMeta: handler is last positional arg (route-level mws don't shadow meta)", async () => {
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
		assert.deepEqual(seen, { permission: "x:read" });
	});
});

test("routeMeta: works for file-based routes (meta on exported handler)", async () => {
	const _dirname = dirname(fileURLToPath(import.meta.url));
	const root = join(_dirname, "./fixtures/_root_meta");

	const seen: Record<string, unknown> = {};
	const app = demino();
	app.use((_r, _i, ctx) => {
		seen[ctx.route] = ctx.routeMeta;
	});
	await deminoFileBased(app, [root], { verbose: false });

	await withServer(app, async (base) => {
		await assertResp(fetch(`${base}/`), 200);
		assert.deepEqual(seen["/"], { permission: "home:read" });
	});
});

test("withMeta: merges and returns the same handler", () => {
	const h: DeminoHandler = () => "ok";
	const ret = withMeta({ a: 1 }, h);
	assert.ok(ret === h, "withMeta must return the same handler reference");
	withMeta({ b: 2 }, h);
	assert.deepEqual(h.meta, { a: 1, b: 2 });
});
