import { assertEquals, assertMatch, assert } from "@std/assert";
import { demino } from "./demino.ts";

const PORT = 9876;
type Srv = {
	ac: AbortController;
	port: number;
	base: string;
	server: ReturnType<typeof Deno.serve>;
};

async function startServer(handler: Deno.ServeHandler, port = PORT) {
	const ac = new AbortController();
	const server = await Deno.serve({ port, signal: ac.signal }, handler);
	return { port, ac, server, base: `http://localhost:${port}` };
}

const hello = (mountPath = "", midwares = [], options = {}) => {
	const app = demino(mountPath, midwares, options);
	const world = "world";
	//
	app.all("/", () => world);
	app.get("/2", async () => await Promise.resolve(new Response(world)));
	app.get("/3", [() => world]); // midware return
	app.get("/4", [() => Promise.resolve(new Response(world))]); // midware return
	//
	app.post("/post", () => "post");
	app.patch("/patch", () => "patch");
	app.put("/put", () => "put");
	app.delete("/delete", () => "delete");
	app.head("/head", () => "head");
	return app;
};

Deno.test("no route is not found", async () => {
	let srv: Srv | null = null;
	let resp: Response;

	const app = demino();

	try {
		srv = await startServer(app);
		resp = await fetch(srv.base);
		assertEquals(resp.status, 404);
		assertMatch(await resp.text(), /not found/i);
	} catch (e) {
		throw e;
	} finally {
		srv?.ac?.abort();
	}

	return srv?.server?.finished;
});

Deno.test("hello world", async () => {
	let srv: Srv | null = null;
	let resp: Response;

	const app = hello();

	// execute the server request
	try {
		srv = await startServer(app);

		// raw text
		resp = await fetch(srv.base);
		assertEquals(resp.status, 200);
		assertMatch(await resp.text(), /world/i);

		// awaited Response
		resp = await fetch(`${srv.base}/2`);
		assertEquals(resp.status, 200);
		assertMatch(await resp.text(), /world/i);

		// this is get only
		resp = await fetch(`${srv.base}/2`, { method: "POST" });
		assertEquals(resp.status, 404);
		assert(await resp.text());

		// midware returns string
		resp = await fetch(`${srv.base}/3`);
		assertEquals(resp.status, 200);
		assertMatch(await resp.text(), /world/i);

		// midware returns awaited Response
		resp = await fetch(`${srv.base}/4`);
		assertEquals(resp.status, 200);
		assertMatch(await resp.text(), /world/i);
	} catch (e) {
		throw e;
	} finally {
		srv?.ac?.abort();
	}

	return srv?.server?.finished;
});

Deno.test("mounted hello world", async () => {
	let srv: Srv | null = null;
	let resp: Response;

	const mount = "/hello";
	const app = hello(mount, [], { verbose: false });

	// execute the server request
	try {
		srv = await startServer(app);

		// route is on "all"
		resp = await fetch(`${srv.base}${mount}`, { method: "POST" });
		assertMatch(await resp.text(), /world/i);

		// awaited Response
		resp = await fetch(`${srv.base}${mount}/2`);
		assertMatch(await resp.text(), /world/i);

		// midware returns string
		resp = await fetch(`${srv.base}${mount}/3`);
		assertMatch(await resp.text(), /world/i);

		// midware returns awaited Response
		resp = await fetch(`${srv.base}${mount}/4`);
		assertMatch(await resp.text(), /world/i);

		const names = ["post", "patch", "put", "delete", "head"];
		for (const method of names) {
			resp = await fetch(`${srv.base}${mount}/${method}`, { method });
			assertEquals(resp.status, 200);
			// head has empty body
			assertEquals(await resp.text(), method === "head" ? "" : method);
		}
	} catch (e) {
		throw e;
	} finally {
		srv?.ac?.abort();
	}

	return srv?.server?.finished;
});

Deno.test.ignore("middlewares", async () => {});

Deno.test.ignore("context", async () => {});

Deno.test.ignore("named route params", async () => {});

Deno.test.ignore("custom error handler", async () => {});

Deno.test.ignore("composition", async () => {});
