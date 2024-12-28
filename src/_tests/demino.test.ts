// deno-lint-ignore-file no-explicit-any

import {
	createHttpError,
	getErrorMessage,
	HTTP_ERROR,
	HTTP_STATUS,
} from "@marianmeres/http-utils";
import { assert, assertEquals } from "@std/assert";
import { demino, DeminoLogger, type DeminoHandler } from "../demino.ts";
import { assertResp, startTestServer } from "./_utils.ts";
import { sleep } from "@marianmeres/midware";

type Srv = Awaited<ReturnType<typeof startTestServer>>;

const hello = (mountPath = "", midwares = [], options = {}) => {
	const world = "world";

	const app = demino(mountPath, midwares, options)
		.all("/", () => world)
		.get("/2", async () => await Promise.resolve(new Response(world)))
		// midware return
		.get("/3", [() => world])
		// this will never be used, because the first usage above wins
		.get("/4", [() => Promise.resolve(new Response(world))])
		// midware return
		.get("/4", () => "never used");

	//
	app
		.post("/post", () => "post")
		.patch("/patch", () => "patch")
		.put("/put", () => "put")
		.delete("/delete", () => "delete")
		.head("/head", () => "head");

	return app;
};

Deno.test("no route is not found", async () => {
	let srv: Srv | null = null;
	try {
		srv = await startTestServer(demino());
		await assertResp(fetch(`${srv.base}`), 404);
	} catch (e) {
		throw e;
	} finally {
		srv?.ac?.abort();
	}

	return srv?.server?.finished;
});

Deno.test("hello world", async () => {
	let srv: Srv | null = null;

	try {
		const app = hello();
		srv = await startTestServer(app);

		// raw text
		await assertResp(fetch(`${srv.base}`), 200, /world/i);
		// awaited Response
		await assertResp(fetch(`${srv.base}/2`), 200, /world/i);
		// this is get only
		await assertResp(fetch(`${srv.base}/2`, { method: "POST" }), 404);
		// midware returns string
		await assertResp(fetch(`${srv.base}/3`), 200, /world/i);
		// midware returns awaited Response
		await assertResp(fetch(`${srv.base}/4`), 200, /world/i);
	} catch (e) {
		throw e;
	} finally {
		srv?.ac?.abort();
	}

	return srv?.server?.finished;
});

Deno.test("mounted hello world", async () => {
	let srv: Srv | null = null;

	try {
		const mount = "/hello";
		const app = hello(mount, [], { verbose: false });

		//
		srv = await startTestServer(app);

		// route is on "all"
		await assertResp(
			fetch(`${srv.base}${mount}`, { method: "POST" }),
			200,
			/world/i
		);
		// awaited Response
		await assertResp(fetch(`${srv.base}${mount}/2`), 200, /world/i);
		// midware returns string
		await assertResp(fetch(`${srv.base}${mount}/3`), 200, /world/i);
		// midware returns awaited Response
		await assertResp(fetch(`${srv.base}${mount}/4`), 200, /world/i);

		const names = ["post", "patch", "put", "delete", "head"];
		for (const method of names) {
			await assertResp(
				fetch(`${srv.base}${mount}/${method}`, { method }),
				200,
				method === "head" ? "" : method
			);
		}

		// case sensitivity check
		await assertResp(fetch(`${srv.base}${mount}/PoSt`), 404);
	} catch (e) {
		throw e;
	} finally {
		srv?.ac?.abort();
	}

	return srv?.server?.finished;
});

Deno.test("middlewares and various return types", async () => {
	let srv: Srv | null = null;

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
			return { toString: () => "ho" };
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

	app.get("/html", () => `<html><body>html content</body></html>`);

	try {
		srv = await startTestServer(app);

		// "foo" is found, and is sent as json, becase the final handler returns context object
		await assertResp(
			fetch(`${srv.base}/some/foo`),
			200,
			{ some: "bar" },
			{
				"X-VERSION": "1.2.3",
				"content-type": /json/,
			}
		);

		// "bar" return via toJSON as json
		await assertResp(
			fetch(`${srv.base}/some/bar`),
			200,
			{ baz: "bat" },
			{ "content-type": /json/ }
		);

		// "bar" return via toJSON as json
		await assertResp(fetch(`${srv.base}/some/hey`), 200, "ho", {
			"content-type": /text\/html/,
		});

		// any other is not found
		await assertResp(fetch(`${srv.base}/some/bla`), 404, /some not found/i, {
			"content-type": /text\/html/,
		});

		// no content empty body
		await assertResp(
			fetch(`${srv.base}/no-content`),
			HTTP_STATUS.NO_CONTENT,
			""
		);

		// mirror post data
		const hey = { hey: "ho", lets: "go", rand: Math.random() };
		await assertResp(
			fetch(`${srv.base}/echo`, { method: "POST", body: JSON.stringify(hey) }),
			200,
			hey
		);

		// check html content-type
		await assertResp(fetch(`${srv.base}/html`), 200, /html content/i, {
			"content-type": /text\/html/,
		});

		//
	} catch (e) {
		throw e;
	} finally {
		srv?.ac?.abort();
	}

	return srv?.server?.finished;
});

Deno.test("middlewares sort order", async () => {
	let srv: Srv | null = null;
	const log: number[] = [];
	const m1: DeminoHandler = () => {
		log.push(1);
	};
	const m2: DeminoHandler = () => {
		log.push(2);
	};
	const m3: DeminoHandler = () => {
		log.push(3);
	};

	const app = demino("", m1);

	// use have to be set above the handler
	app.use(m2, [m3]);

	app.get("/", () => log.join());

	// but this can be set also below
	m2.__midwarePreExecuteSortOrder = 0;

	try {
		srv = await startTestServer(app);
		await assertResp(fetch(`${srv.base}`), 200, /2,1,3/i);
	} catch (e) {
		throw e;
	} finally {
		srv?.ac?.abort();
	}

	return srv?.server?.finished;
});

Deno.test("global route middlewares", async () => {
	let srv: Srv | null = null;
	let log: number[] = [];
	const m1: DeminoHandler = () => {
		log.push(1);
	};
	const m2: DeminoHandler = () => {
		log.push(2);
	};
	const m3: DeminoHandler = () => {
		log.push(3);
	};
	const m4: DeminoHandler = () => {
		log.push(4);
	};

	try {
		const app = demino("", m1);
		srv = await startTestServer(app);

		// lets register routes bellow server start (which must make no difference)
		app
			.use("/[id]", m3)
			.use(m2) // note, that this will take effect before m3
			.get("/[id]", m4, (_r, _i, c) => c.params.id)
			.post("/[id]", (_r, _i, c) => c.params.id);

		await assertResp(fetch(`${srv.base}`), 404);
		assertEquals(log.length, 0);

		// all 4 mws in effect
		await assertResp(fetch(`${srv.base}/foo`), 200, "foo");
		assertEquals(log, [1, 2, 3, 4]);

		// only first 3
		log = [];
		await assertResp(fetch(`${srv.base}/foo`, { method: "POST" }), 200, "foo");
		assertEquals(log, [1, 2, 3]);
	} catch (e) {
		throw e;
	} finally {
		srv?.ac?.abort();
	}

	return srv?.server?.finished;
});

Deno.test("error handler", async () => {
	let srv: Srv | null = null;

	const app = demino();
	app.get("/foo", () => {
		const e: any = new Error("Bar");
		e.code = 12345;
		throw e;
	});

	try {
		srv = await startTestServer(app);
		await assertResp(fetch(`${srv.base}/foo`), 500, /bar/i); // not 12345
	} catch (e) {
		throw e;
	} finally {
		srv?.ac?.abort();
	}

	return srv?.server?.finished;
});

Deno.test("custom error handler", async () => {
	let srv: Srv | null = null;

	const app = demino();

	// return, not throw
	app.get("/err", () => new Error("Boo"));
	app.get("/secret", () => {
		throw createHttpError(HTTP_STATUS.FORBIDDEN);
	});

	try {
		srv = await startTestServer(app);

		await assertResp(fetch(`${srv.base}`), 404, /not found/i, {
			"content-type": /text\/html/,
		});

		await assertResp(fetch(`${srv.base}/err`), 500, "Boo");
		await assertResp(
			fetch(`${srv.base}/secret`),
			HTTP_STATUS.FORBIDDEN,
			"Forbidden"
		);

		// now register custom error handler which will talk always in json
		app.error((_req, _info, ctx) => {
			const e = ctx.error;
			return { ok: false, message: getErrorMessage(e) };
		});

		await assertResp(
			fetch(`${srv.base}/secret`),
			HTTP_STATUS.FORBIDDEN,
			{ ok: false, message: "Forbidden" },
			{ "content-type": /json/ }
		);

		// repeat, and expect json
		await assertResp(
			fetch(`${srv.base}`),
			404,
			{ ok: false, message: "Not Found" },
			{ "content-type": /json/ }
		);

		// err
		await assertResp(fetch(`${srv.base}/err`), 500, {
			ok: false,
			message: "Boo",
		});
	} catch (e) {
		throw e;
	} finally {
		srv?.ac?.abort();
	}

	return srv?.server?.finished;
});

Deno.test("catch all fallback route", async () => {
	let srv: Srv | null = null;

	const app = demino();
	app.get("/", () => "index");
	// this is a fallback if no other route was matched
	app.all("*", () => "hey");

	try {
		srv = await startTestServer(app);

		await assertResp(fetch(`${srv.base}`), 200, /index/i);
		await assertResp(
			fetch(`${srv.base}/${Math.random()}`, { method: "POST" }),
			200,
			/hey/i
		);
	} catch (e) {
		throw e;
	} finally {
		srv?.ac?.abort();
	}

	return srv?.server?.finished;
});

Deno.test("same route different method", async () => {
	let srv: Srv | null = null;

	const methods = ["get", "post", "patch", "put", "delete"];
	const app = demino();
	for (const method of methods) {
		(app as any)[method]("/", () => method);
	}

	try {
		srv = await startTestServer(app);

		for (const method of methods) {
			await assertResp(fetch(`${srv.base}`, { method }), 200, method);
		}
	} catch (e) {
		throw e;
	} finally {
		srv?.ac?.abort();
	}

	return srv?.server?.finished;
});

Deno.test("default router vs trailing slashes", async () => {
	let srv: Srv | null = null;

	const app = demino();
	app.get("/[name]", (_r, _i, c) => c.params);

	try {
		srv = await startTestServer(app);

		await assertResp(fetch(`${srv.base}/foo`), 200, { name: "foo" });

		// the default SimpleRouter always trim slashes, so this will also match
		// it may be considered both as a feature or as a bug... if not desired, use
		// the shipped trailingSlash middleware
		await assertResp(fetch(`${srv.base}/foo///`), 200, { name: "foo" });
	} catch (e) {
		throw e;
	} finally {
		srv?.ac?.abort();
	}

	return srv?.server?.finished;
});

Deno.test("first route match wins", async () => {
	let srv: Srv | null = null;

	const app = demino();

	app.get("/a/static", (_r, _i, c) => "a/static");
	app.get("/a/[name]", (_r, _i, c) => "a/name: " + c.params.name);

	// parametrized will always win as "static" is validly resolved as param
	app.get("/b/[name]", (_r, _i, c) => "b/name: " + c.params.name);
	app.get("/b/static", (_r, _i, c) => "b/static"); // never reached

	try {
		srv = await startTestServer(app);
		await assertResp(fetch(`${srv.base}/a/static`), 200, "a/static");
		await assertResp(fetch(`${srv.base}/b/static`), 200, "b/name: static");
	} catch (e) {
		throw e;
	} finally {
		srv?.ac?.abort();
	}

	return srv?.server?.finished;
});

Deno.test("access log", async () => {
	let srv: Srv | null = null;

	const _log: string[] = [];
	const logger: DeminoLogger = {
		access: async ({ req, status }) => {
			// intentionally sleeping - must not prevent responding
			await sleep(10);
			const { pathname, search } = new URL(req.url);
			_log.push(`${req.method} ${pathname}${search} ${status}`);
		},
	};

	const app = demino("", [], { logger });

	app.all("/", () => "/");
	app.all("/a", () => "a");
	app.all("/b", () => new HTTP_ERROR.ImATeapot());

	try {
		srv = await startTestServer(app);

		await assertResp(fetch(`${srv.base}/?hey`));
		await assertResp(fetch(`${srv.base}/a`, { method: "POST" }));
		await assertResp(fetch(`${srv.base}/b`, { method: "PUT" }), 418);
		await assertResp(fetch(`${srv.base}/foo/bar?baz=bat`), 404);

		// because logger intentionally sleeps above (must not prevent the server to respond)
		assertEquals(_log.length, 0);

		// wait for logger to complete
		await sleep(100);

		// now check
		assertEquals(_log, [
			"GET /?hey 200",
			"POST /a 200",
			"PUT /b 418",
			"GET /foo/bar?baz=bat 404",
		]);
	} catch (e) {
		throw e;
	} finally {
		srv?.ac?.abort();
	}

	return srv?.server?.finished;
});
