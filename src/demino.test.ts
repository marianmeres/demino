import {
	getErrorMessage,
	HTTP_ERROR,
	HTTP_STATUS,
} from "@marianmeres/http-utils";
import { assert, assertEquals, assertMatch } from "@std/assert";
import { demino, deminoCompose } from "./demino.ts";

const PORT = 9876;
type Srv = {
	ac: AbortController;
	port: number;
	base: string;
	server: ReturnType<typeof Deno.serve>;
};

async function startServer(handler: Deno.ServeHandler, port = PORT) {
	const ac = new AbortController();
	// By default `Deno.serve` prints the message ... If you like to
	// change this behavior, you can specify a custom `onListen` callback.
	const server = await Deno.serve(
		{ port, signal: ac.signal, onListen(_) {} },
		handler
	);
	// server.finished.then(() => console.log("Server closed"));
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
	// this will never be used, because the first usage above wins
	app.get("/4", () => "never used");
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

Deno.test("middlewares and various return types", async () => {
	let srv: Srv | null = null;
	let resp: Response;

	const app = demino("", [
		// example middleware to add custom header (added via factory)
		(_req, _info, context) => {
			context.headers.set("x-version", "1.2.3");
		},
	]);

	// example middleware to load some locals (added via `use`)
	// using misc (and sometimes stupid) strategies to return value
	app.use(async (_req, _info, context) => {
		// return nothing, just set context, the get handler returns
		if (context.params.id == "foo") {
			context.locals.some = await Promise.resolve("bar");
		}
		// return JSON serializable object ASAP (final handler will not be invoked)
		else if (context.params.id == "bar") {
			return { toJSON: () => ({ baz: "bat" }) };
		}
		// return plain string ASAP (final handler will not be invoked)
		else if (context.params.id == "hey") {
			return "ho";
		}
		// not found (intentionally not throwing, just returning, which must also work)
		else if (context.params.id) {
			return new HTTP_ERROR.NotFound("Some not found");
		}
	});

	// as a side effect, just sanity-checking the named segment as well
	app.get("/some/[id]", (_req, _info, context) => {
		return context.locals;
	});

	app.get("/no-content", () => {});

	app.post("/echo", (req) => (req.body ? req.text() : undefined));

	try {
		srv = await startServer(app);

		// "foo" is found, and is sent as json, becase the final handler returns context object
		resp = await fetch(`${srv.base}/some/foo`);
		assertEquals(resp.status, 200);
		assertEquals(resp.headers.get("X-VERSION"), "1.2.3"); // case insensitive
		assertMatch(resp.headers.get("Content-Type")!, /json/);
		assertEquals(await resp.text(), '{"some":"bar"}');

		// "bar" return via toJSON as json
		resp = await fetch(`${srv.base}/some/bar`);
		assertEquals(resp.status, 200);
		assertMatch(resp.headers.get("Content-Type")!, /json/);
		assertEquals(await resp.text(), '{"baz":"bat"}');

		// "bar" return via toJSON as json
		resp = await fetch(`${srv.base}/some/hey`);
		assertEquals(resp.status, 200);
		assertMatch(resp.headers.get("Content-Type")!, /text\/plain/);
		assertEquals(await resp.text(), "ho");

		// any other is not found
		resp = await fetch(`${srv.base}/some/bla`);
		assertEquals(resp.status, 404);
		assertMatch(resp.headers.get("Content-Type")!, /text\/plain/);
		assertMatch(resp.statusText, /not found/i);
		assertMatch(await resp.text(), /some not found/i);

		// no content empty body
		resp = await fetch(`${srv.base}/no-content`);
		assertEquals(await resp.text(), "");
		assertEquals(resp.status, HTTP_STATUS.NO_CONTENT);

		// mirror post data
		const hey = { hey: "ho", lets: "go", rand: Math.random() };
		resp = await fetch(`${srv.base}/echo`, {
			method: "POST",
			body: JSON.stringify(hey),
		});
		assertEquals(JSON.parse(await resp.text()), hey);

		//
	} catch (e) {
		throw e;
	} finally {
		srv?.ac?.abort();
	}

	return srv?.server?.finished;
});

Deno.test("custom error handler", async () => {
	let srv: Srv | null = null;
	let resp: Response;

	const app = demino();

	try {
		srv = await startServer(app);
		resp = await fetch(srv.base);
		assertEquals(resp.status, 404);
		assertMatch(resp.headers.get("Content-Type")!, /text\/plain/);
		assertMatch(await resp.text(), /not found/i);

		// now register custom error handler which will talk always in json
		app.error((_req, _info, ctx) => {
			ctx.headers.set("Content-Type", "application/json; charset=utf-8");
			const e = ctx.error;
			return new Response(
				JSON.stringify({ ok: false, message: getErrorMessage(e) }),
				{
					status: e?.status || HTTP_STATUS.INTERNAL_SERVER_ERROR,
					headers: ctx.headers,
				}
			);
		});

		// repeat, and expect json
		resp = await fetch(srv.base);
		assertEquals(resp.status, 404);
		assertEquals(JSON.parse(await resp.text()), {
			ok: false,
			message: "Not Found",
		});
	} catch (e) {
		throw e;
	} finally {
		srv?.ac?.abort();
	}

	return srv?.server?.finished;
});

Deno.test("composition", async () => {
	let srv: Srv | null = null;
	let resp: Response;

	// landing page example
	const home = demino();
	home.get("/", () => "Hello");
	home.get("/[slug]", (_r, _i, ctx) => `Marketing: ${ctx.params.slug}`);

	// api example
	const api = demino("/api", (_r, _i, ctx) => {
		ctx.headers.set("Content-Type", "application/json; charset=utf-8");
	});
	api.get("/", (_r, _i, _c) => ({ hello: "world" }));
	api.get("/[slug]", (_r, _i, ctx) => ({ api: ctx.params.slug }));

	// etc...
	const blog = demino("/blog");
	blog.get("/[slug]", (_r, _i, ctx) => `Blog: ${ctx.params.slug}`);

	const app = deminoCompose([home, api, blog]);

	try {
		srv = await startServer(app);

		// homepage
		resp = await fetch(srv.base);
		assertEquals(resp.status, 200);
		assertMatch(resp.headers.get("Content-Type")!, /text\/plain/);
		assertMatch(await resp.text(), /hello/i);

		// homepage slug
		resp = await fetch(`${srv.base}/foo`);
		assertEquals(resp.status, 200);
		assertMatch(resp.headers.get("Content-Type")!, /text\/plain/);
		assertMatch(await resp.text(), /Marketing: foo/i);

		// now, this is not api root, but homepage "api" slug
		resp = await fetch(`${srv.base}/api`);
		assertEquals(resp.status, 200);
		assertMatch(resp.headers.get("Content-Type")!, /text\/plain/);
		assertMatch(await resp.text(), /Marketing: api/i);

		// now this is api root
		resp = await fetch(`${srv.base}/api/`);
		assertEquals(resp.status, 200);
		assertMatch(resp.headers.get("Content-Type")!, /json/);
		assertEquals(JSON.parse(await resp.text()), { hello: "world" });

		// homepage slug
		resp = await fetch(`${srv.base}/blog/hey`);
		assertEquals(resp.status, 200);
		assertMatch(resp.headers.get("Content-Type")!, /text\/plain/);
		assertMatch(await resp.text(), /Blog: hey/i);
	} catch (e) {
		throw e;
	} finally {
		srv?.ac?.abort();
	}

	return srv?.server?.finished;
});
