import assert from "node:assert/strict";
import { test } from "node:test";
import { createLogListenInfo, demino, deminoCompose } from "../../src/mod.ts";
import { isDeno } from "../_utils.ts";

/**
 * The portable handler contract must stay a drop-in for `Deno.serve()` with no
 * adapter in between: `Demino` (and `deminoCompose()`'s result) must be assignable
 * to `Deno.ServeHandler` without a cast, and Deno's own `ServeHandlerInfo` must be
 * read correctly as a `DeminoServeInfo` (its `remoteAddr` reaches `ctx.ip`).
 *
 * The two server tests are Deno-only by nature (they call `Deno.serve` directly)
 * and are `{ skip: !isDeno }` elsewhere. The `Deno` global is typed below so the
 * file checks under both checkers: under `deno test`/`deno check` it is Deno's own
 * `typeof Deno`, so the type-level checks run against the real `Deno.ServeHandler`;
 * under a plain `tsc` run (no Deno ambient types) it falls back to a local stand-in
 * of the same shape.
 */

/** `T[K]` when `K` is a key of `T`, else `undefined` - deferred, so `tsc` never
 * resolves `(typeof globalThis)["Deno"]` where there is no such key. */
type Prop<T, K extends PropertyKey> = K extends keyof T ? T[K] : undefined;

/** The slice of `Deno` these tests use, for a checker without Deno's types. */
interface DenoServeStandIn {
	serve(
		options: {
			hostname: string;
			port: number;
			onListen?: (addr: { hostname: string; port: number }) => void;
		},
		handler: (
			req: Request,
			info: { remoteAddr: { hostname: string; port: number; transport: string } },
		) => Response | Promise<Response>,
	): {
		addr: { hostname: string; port: number };
		finished: Promise<void>;
		shutdown(): Promise<void>;
	};
}

/** Deno's real `typeof Deno` when the checker knows it, the stand-in otherwise. */
type DenoGlobal = [Prop<typeof globalThis, "Deno">] extends [undefined] ? DenoServeStandIn
	: Prop<typeof globalThis, "Deno">;

/** The `Deno` global; only called inside `{ skip: !isDeno }` tests. */
function denoGlobal(): DenoGlobal {
	const D = (globalThis as unknown as { Deno?: DenoGlobal }).Deno;
	if (!D) throw new Error("not running on Deno");
	return D;
}

test("Deno.serve(app): no adapter, ctx.ip comes from Deno's own ServeHandlerInfo", {
	skip: !isDeno,
}, async () => {
	const Deno = denoGlobal();
	const app = demino();
	app.logger(null);
	app.get("/ip", (_req, _info, ctx) => ctx.ip);

	// Type-level check: `Demino` is passed where `Deno.ServeHandler` is expected.
	const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, app);
	try {
		const resp = await fetch(`http://127.0.0.1:${server.addr.port}/ip`);
		assert.equal(resp.status, 200);
		assert.equal(await resp.text(), "127.0.0.1");
	} finally {
		await server.shutdown();
		await server.finished;
	}
});

test("Deno.serve(deminoCompose(...)) with logListenInfo as onListen", {
	skip: !isDeno,
}, async () => {
	const Deno = denoGlobal();
	const api = demino("/api");
	api.logger(null);
	api.get("/ip", (_req, _info, ctx) => ctx.ip);

	// Type-level checks: `DeminoServeHandler` → `Deno.ServeHandler`, and the
	// `(addr: DeminoListenAddr) => void` callback → Deno's `onListen`.
	const lines: string[] = [];
	const server = Deno.serve(
		{
			hostname: "127.0.0.1",
			port: 0,
			onListen: createLogListenInfo({ json: true, write: (l) => lines.push(l) }),
		},
		deminoCompose([api]),
	);
	try {
		const resp = await fetch(`http://127.0.0.1:${server.addr.port}/api/ip`);
		assert.equal(resp.status, 200);
		assert.equal(await resp.text(), "127.0.0.1");

		assert.equal(lines.length, 1);
		const parsed = JSON.parse(lines[0]);
		assert.equal(parsed.hostname, "127.0.0.1");
		assert.equal(parsed.port, server.addr.port);
	} finally {
		await server.shutdown();
		await server.finished;
	}
});

test("app called directly with no info: info is normalised to an object, ctx.ip is empty", async () => {
	const app = demino();
	app.logger(null);
	app.get("/ip", (_req, info, ctx) => ({
		ip: ctx.ip,
		infoIsObject: typeof info === "object" && info !== null,
		remoteAddr: info.remoteAddr ?? null,
	}));

	const resp = await app(new Request("http://localhost/ip"));
	assert.equal(resp.status, 200);
	assert.deepEqual(await resp.json(), { ip: "", infoIsObject: true, remoteAddr: null });
});
