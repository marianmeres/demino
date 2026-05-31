import { assert, assertEquals } from "@std/assert";
import {
	type Demino,
	demino,
	type DeminoContext,
	type DeminoRouteInfo,
	withMeta,
} from "../src/demino.ts";
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

/** Find a single routes() row by method+route (asserts uniqueness). */
function row(rows: DeminoRouteInfo[], method: string, route: string) {
	const hits = rows.filter((r) => r.method === method && r.route === route);
	assertEquals(
		hits.length,
		1,
		`expected exactly one ${method} ${route} row, got ${hits.length}`,
	);
	return hits[0];
}

Deno.test("routes(): lists each registration once with its meta", () => {
	const app = demino();
	app.get("/a", withMeta({ perm: "a:read" }, () => "a"));
	app.post("/a", withMeta({ perm: "a:write" }, () => "a"));
	app.get("/b", () => "b");

	const rows = app.routes();

	assertEquals(row(rows, "GET", "/a").meta, { perm: "a:read" });
	assertEquals(row(rows, "POST", "/a").meta, { perm: "a:write" });
	assertEquals(row(rows, "GET", "/b").meta, {});
});

Deno.test("routes(): auto-HEAD is reported (inherits GET registration) ", () => {
	const app = demino();
	app.get("/a", withMeta({ perm: "a:read" }, () => "a"));

	const rows = app.routes();
	// GET registration auto-adds HEAD -> both present, both carry the meta
	assertEquals(row(rows, "GET", "/a").meta, { perm: "a:read" });
	assertEquals(row(rows, "HEAD", "/a").meta, { perm: "a:read" });
});

Deno.test("routes(): ALL-router routes are reported under ALL", () => {
	const app = demino();
	app.all("/x", withMeta({ perm: "x" }, () => "x"));

	const rows = app.routes();
	assertEquals(row(rows, "ALL", "/x").meta, { perm: "x" });
});

Deno.test("routes(): catch-all routes are present", () => {
	const app = demino();
	app.get("/files/*", withMeta({ public: true }, () => "f"));

	const rows = app.routes();
	const hit = rows.find((r) => r.route === "/files/*" && r.method === "GET");
	assert(hit, "catch-all route should be enumerated");
	assertEquals(hit!.meta, { public: true });
});

Deno.test("routes(): meta entries are frozen", () => {
	const app = demino();
	app.get("/a", withMeta({ perm: "a" }, () => "a"));

	const r = row(app.routes(), "GET", "/a");
	assert(Object.isFrozen(r.meta), "routes() meta must be frozen");
});

Deno.test("routes(): reflects re-registration (last registration wins)", () => {
	const app = demino();
	app.get("/a", withMeta({ perm: "old" }, () => "a"));
	app.get("/a", withMeta({ perm: "new" }, () => "a2"));

	assertEquals(row(app.routes(), "GET", "/a").meta, { perm: "new" });
});

Deno.test("routes(): mount path is reflected in reported routes", () => {
	const app = demino("/api");
	app.get("/users", withMeta({ perm: "users:read" }, () => "u"));

	assertEquals(row(app.routes(), "GET", "/api/users").meta, {
		perm: "users:read",
	});
});

// The load-bearing invariant: what app.routes() reports for a (method, route)
// MUST equal what ctx.routeMeta is for an actual matched request to that route.
// If these diverge, any build-time audit built on routes() is false-green.
Deno.test("routes(): A/B invariant — routes() meta equals per-request ctx.routeMeta", async () => {
	const seen: Record<string, Readonly<Record<string, unknown>>> = {};

	const app = demino();
	app.use((_r, _i, ctx: DeminoContext) => {
		seen[`${ctx.route}`] = ctx.routeMeta;
	});
	app.get("/a", withMeta({ perm: "a:read" }, () => "a"));
	app.get("/b/[id]", withMeta({ perm: "b:read" }, () => "b"));
	app.get("/c", () => "c");

	const rows = app.routes();

	await withServer(app, async (base) => {
		await assertResp(fetch(`${base}/a`), 200, "a");
		await assertResp(fetch(`${base}/b/123`), 200, "b");
		await assertResp(fetch(`${base}/c`), 200, "c");

		// per-request routeMeta must deep-equal the routes() entry for that route
		assertEquals(seen["/a"], row(rows, "GET", "/a").meta);
		assertEquals(seen["/b/[id]"], row(rows, "GET", "/b/[id]").meta);
		assertEquals(seen["/c"], row(rows, "GET", "/c").meta);
	});
});
