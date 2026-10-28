import { assertEquals } from "@std/assert";
import { createLogListenInfo, demino, deminoCompose } from "../../src/mod.ts";

/**
 * The portable handler contract must stay a drop-in for `Deno.serve()` with no
 * adapter in between: `Demino` (and `deminoCompose()`'s result) must be assignable
 * to `Deno.ServeHandler` without a cast, and Deno's own `ServeHandlerInfo` must be
 * read correctly as a `DeminoServeInfo` (its `remoteAddr` reaches `ctx.ip`).
 *
 * This is Deno-only by nature (it calls `Deno.serve` directly); once the suite runs
 * on `node:test` it becomes `test(name, { skip: !isDeno }, …)`.
 */

Deno.test("Deno.serve(app): no adapter, ctx.ip comes from Deno's own ServeHandlerInfo", async () => {
	const app = demino();
	app.logger(null);
	app.get("/ip", (_req, _info, ctx) => ctx.ip);

	// Type-level check: `Demino` is passed where `Deno.ServeHandler` is expected.
	const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, app);
	try {
		const resp = await fetch(`http://127.0.0.1:${server.addr.port}/ip`);
		assertEquals(resp.status, 200);
		assertEquals(await resp.text(), "127.0.0.1");
	} finally {
		await server.shutdown();
		await server.finished;
	}
});

Deno.test("Deno.serve(deminoCompose(...)) with logListenInfo as onListen", async () => {
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
		assertEquals(resp.status, 200);
		assertEquals(await resp.text(), "127.0.0.1");

		assertEquals(lines.length, 1);
		const parsed = JSON.parse(lines[0]);
		assertEquals(parsed.hostname, "127.0.0.1");
		assertEquals(parsed.port, server.addr.port);
	} finally {
		await server.shutdown();
		await server.finished;
	}
});

Deno.test("app called directly with no info: info is normalised to an object, ctx.ip is empty", async () => {
	const app = demino();
	app.logger(null);
	app.get("/ip", (_req, info, ctx) => ({
		ip: ctx.ip,
		infoIsObject: typeof info === "object" && info !== null,
		remoteAddr: info.remoteAddr ?? null,
	}));

	const resp = await app(new Request("http://localhost/ip"));
	assertEquals(resp.status, 200);
	assertEquals(await resp.json(), { ip: "", infoIsObject: true, remoteAddr: null });
});
