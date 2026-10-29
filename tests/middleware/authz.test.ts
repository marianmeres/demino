import assert from "node:assert/strict";
import { test } from "node:test";
import { type Demino, demino } from "../../src/demino.ts";
import {
	type AuthzDecl,
	assertCovered,
	authz,
	createRouteResolver,
	getSubject,
	permissionMatrix,
	withPermission,
	withPublic,
} from "../../src/middleware/authz.ts";
import { assertResp, startTestServer } from "../_utils.ts";

type Srv = Awaited<ReturnType<typeof startTestServer>>;

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

/** A trivial subject resolver: header `x-user` -> { id, perms } where perms is csv. */
const resolveSubject = (req: Request) => {
	const u = req.headers.get("x-user");
	if (!u) return null;
	const [id, perms = ""] = u.split("|");
	return { id, perms: perms ? perms.split(",") : [] };
};
const check = (subject: unknown, permission: string) =>
	(subject as { perms: string[] }).perms.includes(permission);

test("authz: withPermission allows when check passes, 403 when it fails", async () => {
	const app = demino();
	app.use(authz({ resolveSubject, check }));
	app.get(
		"/x",
		withPermission("x:read", () => "ok"),
	);

	await withServer(app, async (base) => {
		await assertResp(
			fetch(`${base}/x`, { headers: { "x-user": "u1|x:read" } }),
			200,
			"ok",
		);
		await assertResp(
			fetch(`${base}/x`, { headers: { "x-user": "u1|other:perm" } }),
			403,
		);
	});
});

test("authz: 401 when permission required but no subject", async () => {
	const app = demino();
	app.use(authz({ resolveSubject, check }));
	app.get(
		"/x",
		withPermission("x:read", () => "ok"),
	);

	await withServer(app, async (base) => {
		await assertResp(fetch(`${base}/x`), 401);
	});
});

test("authz: withPublic allows without subject", async () => {
	const app = demino();
	app.use(authz({ resolveSubject, check }));
	app.get(
		"/pub",
		withPublic(() => "pub"),
	);

	await withServer(app, async (base) => {
		await assertResp(fetch(`${base}/pub`), 200, "pub");
	});
});

test("authz: deny-by-default — undeclared route is 403", async () => {
	const app = demino();
	app.use(authz({ resolveSubject, check }));
	app.get("/undeclared", () => "should not reach");

	await withServer(app, async (base) => {
		await assertResp(
			fetch(`${base}/undeclared`, { headers: { "x-user": "u1|anything" } }),
			403,
		);
	});
});

test("authz: denyByDefault=false lets undeclared routes through", async () => {
	const app = demino();
	app.use(authz({ resolveSubject, check, denyByDefault: false }));
	app.get("/undeclared", () => "reached");

	await withServer(app, async (base) => {
		await assertResp(fetch(`${base}/undeclared`), 200, "reached");
	});
});

test("authz: array permissions — every (default) vs some", async () => {
	const app = demino();
	app.use(authz({ resolveSubject, check }));
	app.get(
		"/every",
		withPermission(["a", "b"], () => "ok"),
	); // default every
	app.get(
		"/some",
		withPermission(["a", "b"], () => "ok", { mode: "some" }),
	);

	await withServer(app, async (base) => {
		// every: needs both
		await assertResp(fetch(`${base}/every`, { headers: { "x-user": "u|a,b" } }), 200);
		await assertResp(fetch(`${base}/every`, { headers: { "x-user": "u|a" } }), 403);
		// some: needs any
		await assertResp(fetch(`${base}/some`, { headers: { "x-user": "u|a" } }), 200);
		await assertResp(fetch(`${base}/some`, { headers: { "x-user": "u|c" } }), 403);
	});
});

test("authz: empty permission array is rejected at declaration (fail-closed)", () => {
	assert.throws(() => withPermission([], () => "x"), {
		name: "TypeError",
		message: /must not be empty/,
	});
});

test("authz: empty permission via resolve denies (403, never fails open)", async () => {
	const app = demino();
	app.use(
		authz({
			resolveSubject,
			check,
			// a hand-built decl with an empty permission list must not fail open
			resolve: () => ({ permission: [] }) as AuthzDecl,
		}),
	);
	app.get("/x", () => "ok"); // no static decl -> resolve supplies the (empty) perms

	await withServer(app, async (base) => {
		// authenticated subject, but the vacuous permission list must still 403
		await assertResp(fetch(`${base}/x`, { headers: { "x-user": "u|a,b" } }), 403);
	});
});

test("authz: a non-preflight OPTIONS on a matched route is still gated", async () => {
	const app = demino();
	app.use(authz({ resolveSubject, check }));
	app.all(
		"/admin",
		withPermission("admin:*", () => "secret"),
	);

	await withServer(app, async (base) => {
		// bare OPTIONS (NOT a preflight) matches the app.all route -> the gate runs
		// and denies (401, no subject); it must not bypass unauthenticated.
		const bare = await fetch(`${base}/admin`, { method: "OPTIONS" });
		await bare.text();
		assert.equal(bare.status, 401);

		// a genuine preflight (carries Access-Control-Request-Method) bypasses the gate
		const pre = await fetch(`${base}/admin`, {
			method: "OPTIONS",
			headers: { "access-control-request-method": "GET" },
		});
		await pre.text();
		assert.ok(
			pre.status !== 401 && pre.status !== 403,
			`preflight gated: ${pre.status}`,
		);
	});
});

test("authz: OPTIONS is bypassed (preflight)", async () => {
	const app = demino();
	app.use(authz({ resolveSubject, check }));
	// OPTIONS has no real handler here; bypass means the gate doesn't 403/401 it.
	// A bare OPTIONS with no route -> 404 (not 401/403), proving the gate let it pass.
	app.get(
		"/x",
		withPermission("x:read", () => "ok"),
	);

	await withServer(app, async (base) => {
		const r = await fetch(`${base}/x`, { method: "OPTIONS" });
		await r.text();
		// no OPTIONS handler registered -> framework 404/405, crucially NOT 401/403
		assert.ok(r.status !== 401 && r.status !== 403, `got ${r.status}`);
	});
});

test("authz: auto-HEAD inherits the GET decl (200/403 mirrors GET)", async () => {
	const app = demino();
	app.use(authz({ resolveSubject, check }));
	app.get(
		"/x",
		withPermission("x:read", () => "ok"),
	);

	await withServer(app, async (base) => {
		await assertResp(
			fetch(`${base}/x`, { method: "HEAD", headers: { "x-user": "u|x:read" } }),
			200,
			"",
		);
		await assertResp(
			fetch(`${base}/x`, { method: "HEAD", headers: { "x-user": "u|nope" } }),
			403,
			"",
		);
	});
});

test("authz: composes with a pre-set subject (no resolveSubject)", async () => {
	const app = demino();
	// a prior middleware sets the subject; gate just reads it
	app.use((_r, _i, ctx) => {
		ctx.locals.subject = { id: "pre", perms: ["x:read"] };
	});
	app.use(authz({ check })); // no resolveSubject
	app.get(
		"/x",
		withPermission("x:read", () => "ok"),
	);

	await withServer(app, async (base) => {
		await assertResp(fetch(`${base}/x`), 200, "ok");
	});
});

test("authz: subject is populated even on public routes", async () => {
	let seen: unknown = "unset";
	const app = demino();
	app.use(authz({ resolveSubject, check }));
	app.get(
		"/pub",
		withPublic((_r, _i, ctx) => {
			seen = getSubject<{ id: string }>(ctx);
			return "pub";
		}),
	);

	await withServer(app, async (base) => {
		await assertResp(fetch(`${base}/pub`, { headers: { "x-user": "u9|" } }), 200);
		assert.equal((seen as { id: string }).id, "u9");
	});
});

test("authz: resolve fallback gates routes without static decl", async () => {
	const resolve = createRouteResolver([
		["/health", { public: true }],
		["/api/**", { permission: "api:access" }],
	]);
	const app = demino();
	app.use(authz({ resolveSubject, check, resolve }));
	app.get("/health", () => "ok"); // no static decl -> resolver public
	app.get("/api/[id]", () => "data"); // no static decl -> resolver permission

	await withServer(app, async (base) => {
		await assertResp(fetch(`${base}/health`), 200, "ok");
		await assertResp(
			fetch(`${base}/api/1`, { headers: { "x-user": "u|api:access" } }),
			200,
			"data",
		);
		await assertResp(
			fetch(`${base}/api/1`, { headers: { "x-user": "u|nope" } }),
			403,
		);
	});
});

test("authz: static decl wins over resolver", async () => {
	const resolve = createRouteResolver([["/x", { public: true }]]);
	const app = demino();
	app.use(authz({ resolveSubject, check, resolve }));
	// static says permission required, resolver says public -> static must win
	app.get(
		"/x",
		withPermission("x:read", () => "ok"),
	);

	await withServer(app, async (base) => {
		await assertResp(fetch(`${base}/x`), 401); // needs subject -> static won
	});
});

test("authz: async check (ownership via ctx) ", async () => {
	const app = demino();
	app.use(
		authz({
			resolveSubject,
			// async: pretend to load a resource and check ownership
			check: async (subject, _permission, ctx) => {
				const res = (ctx.locals.resource ??= await Promise.resolve({
					owner: ctx.params.id,
				})) as { owner: string };
				return res.owner === (subject as { id: string }).id;
			},
		}),
	);
	app.get(
		"/things/[id]",
		withPermission("thing:read", () => "ok"),
	);

	await withServer(app, async (base) => {
		// owner matches param id
		await assertResp(
			fetch(`${base}/things/u1`, { headers: { "x-user": "u1|x" } }),
			200,
			"ok",
		);
		await assertResp(
			fetch(`${base}/things/u2`, { headers: { "x-user": "u1|x" } }),
			403,
		);
	});
});

// ---- createRouteResolver matcher ----

test("createRouteResolver: * matches one segment, ** matches the rest", () => {
	const resolve = createRouteResolver([
		["/a/*", { permission: "one" } as AuthzDecl],
		["/b/**", { permission: "rest" } as AuthzDecl],
	]);
	assert.deepEqual(resolve("GET", "/a/x"), { permission: "one" });
	assert.deepEqual(resolve("GET", "/a/x/y"), null); // * is single segment
	assert.deepEqual(resolve("GET", "/b/x"), { permission: "rest" });
	assert.deepEqual(resolve("GET", "/b/x/y/z"), { permission: "rest" });
	assert.deepEqual(resolve("GET", "/c"), null);
});

test("createRouteResolver: literal route param brackets are matched literally", () => {
	const resolve = createRouteResolver([["/u/[id]", { public: true }]]);
	assert.deepEqual(resolve("GET", "/u/[id]"), { public: true });
	assert.deepEqual(resolve("GET", "/u/x"), null);
});

test("createRouteResolver: first match wins", () => {
	const resolve = createRouteResolver([
		["/a/**", { permission: "broad" }],
		["/a/specific", { public: true }],
	]);
	// broad registered first -> wins
	assert.deepEqual(resolve("GET", "/a/specific"), { permission: "broad" });
});

// ---- permissionMatrix / assertCovered ----

test("permissionMatrix: tags static/resolver/public/MISSING correctly", () => {
	const resolve = createRouteResolver([["/api/**", { permission: "api:access" }]]);
	const app = demino();
	app.get(
		"/x",
		withPermission("x:read", () => "ok"),
	);
	app.get(
		"/pub",
		withPublic(() => "ok"),
	);
	app.get("/api/[id]", () => "ok"); // resolver
	app.get("/orphan", () => "ok"); // MISSING

	const rows = permissionMatrix(app, { resolve });
	const get = (route: string) =>
		rows.find((r) => r.route === route && r.method === "GET")!;

	assert.equal(get("/x").declaration, "permission");
	assert.equal(get("/x").permission, "x:read");
	assert.equal(get("/x").source, "static");
	assert.equal(get("/pub").declaration, "public");
	assert.equal(get("/api/[id]").declaration, "permission");
	assert.equal(get("/api/[id]").source, "resolver");
	assert.equal(get("/orphan").declaration, "MISSING");
});

test("assertCovered: throws listing MISSING routes, passes when all declared", () => {
	const app = demino();
	app.get(
		"/x",
		withPermission("x:read", () => "ok"),
	);
	app.get("/orphan", () => "ok");

	let threw = false;
	try {
		assertCovered(app);
	} catch (e) {
		threw = true;
		assert.ok(
			(e as Error).message.includes("/orphan"),
			"should name the orphan route",
		);
	}
	assert.ok(threw, "assertCovered must throw on an undeclared route");

	// now cover it -> no throw
	const app2 = demino();
	app2.get(
		"/x",
		withPermission("x:read", () => "ok"),
	);
	app2.get(
		"/pub",
		withPublic(() => "ok"),
	);
	assertCovered(app2); // should not throw
});

test("permissionMatrix: A/B — matrix permission equals what the gate enforces", async () => {
	const app = demino();
	app.use(authz({ resolveSubject, check }));
	app.get(
		"/x",
		withPermission("x:read", () => "ok"),
	);

	const row = permissionMatrix(app).find(
		(r) => r.route === "/x" && r.method === "GET",
	)!;
	assert.equal(row.permission, "x:read");

	await withServer(app, async (base) => {
		// having exactly the matrix-declared permission -> allowed
		await assertResp(
			fetch(`${base}/x`, { headers: { "x-user": `u|${row.permission}` } }),
			200,
			"ok",
		);
	});
});
