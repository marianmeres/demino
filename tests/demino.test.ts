import {
	createHttpError,
	getErrorMessage,
	HTTP_ERROR,
	HTTP_STATUS,
} from "@marianmeres/http-utils";
import { sleep } from "@marianmeres/midware";
import { assertEquals } from "@std/assert";
import {
	type Demino,
	demino,
	type DeminoHandler,
	type DeminoLogger,
	type Logger,
} from "../src/demino.ts";
import { assertResp, runTestServerTests, startTestServer } from "./_utils.ts";

type Srv = Awaited<ReturnType<typeof startTestServer>>;
const _clog = console.log;

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
		.delete("/delete", () => "delete");
	// .head("/head", () => "head");

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
		app.logger(null);

		//
		srv = await startTestServer(app);

		// route is on "all"
		await assertResp(
			fetch(`${srv.base}${mount}`, { method: "POST" }),
			200,
			/world/i,
		);
		// awaited Response
		await assertResp(fetch(`${srv.base}${mount}/2`), 200, /world/i);
		// midware returns string
		await assertResp(fetch(`${srv.base}${mount}/3`), 200, /world/i);
		// midware returns awaited Response
		await assertResp(fetch(`${srv.base}${mount}/4`), 200, /world/i);

		const names = ["post", "patch", "put", "delete"];
		for (const method of names) {
			await assertResp(
				fetch(`${srv.base}${mount}/${method}`, { method }),
				200,
				method,
			);
			// head must return 405 for not get registered routes
			await assertResp(
				fetch(`${srv.base}${mount}/${method}`, { method: "HEAD" }),
				405,
				"",
			);
		}

		// HEAD for existing GET must work out-of-the-box
		for (const p of ["", 2, 3, 4]) {
			await assertResp(
				fetch(`${srv.base}${mount}/${p}`, { method: "HEAD" }),
				200,
				"",
			);
		}

		// but not for 404s
		await assertResp(
			fetch(`${srv.base}${mount}/asdf`, { method: "HEAD" }),
			404,
			false,
		);

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
		} // return JSON serializable object ASAP (final handler will not be invoked)
		else if (context.params.id == "bar") {
			return { toJSON: () => ({ baz: "bat" }) };
		} // return plain string ASAP (final handler will not be invoked)
		else if (context.params.id == "hey") {
			return { toString: () => "ho" };
		} // not found (intentionally not throwing, just returning, which must also work)
		else if (context.params.id) {
			return new HTTP_ERROR.NotFound("Some not found");
		}
	});

	// as a side effect, just sanity-checking the named segment as well
	app.get("/some/[id]", (_req, _info, context) => {
		return context.locals;
	});

	app.get("/no-content", () => {});

	app.get("/array", () => [1, 2, 3]);

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
			},
		);

		// "bar" return via toJSON as json
		await assertResp(
			fetch(`${srv.base}/some/bar`),
			200,
			{ baz: "bat" },
			{ "content-type": /json/ },
		);

		// array
		await assertResp(fetch(`${srv.base}/array`), 200, [1, 2, 3], {
			"content-type": /json/,
		});

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
			"",
		);

		// mirror post data
		const hey = { hey: "ho", lets: "go", rand: Math.random() };
		await assertResp(
			fetch(`${srv.base}/echo`, { method: "POST", body: JSON.stringify(hey) }),
			200,
			hey,
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

Deno.test("constructor middleware array is defensively copied", () => {
	const m1: DeminoHandler = () => "m1";
	const m2: DeminoHandler = () => "m2";
	const m3: DeminoHandler = () => "m3";
	const mws = [m1, m2];

	const a = demino("/a", mws);
	const b = demino("/b", mws);

	a.use(m3);

	assertEquals(a.info().globalAppMiddlewaresCount, 3);
	assertEquals(b.info().globalAppMiddlewaresCount, 2);
	assertEquals(mws.length, 2);
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
	app.logger(null);
	app.get("/foo", () => {
		const e = new Error("Bar") as Error & { code: number };
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
	app.logger(null);

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
			"Forbidden",
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
			{ "content-type": /json/ },
		);

		// repeat, and expect json
		await assertResp(
			fetch(`${srv.base}`),
			404,
			{ ok: false, message: "Not Found" },
			{ "content-type": /json/ },
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

Deno.test("custom error handler via options", async () => {
	let srv: Srv | null = null;

	const app = demino("", [], {
		errorHandler: (_r, _i, c) => ({ error: getErrorMessage(c.error) }),
	});

	try {
		srv = await startTestServer(app);
		await assertResp(fetch(`${srv.base}/foo`), 404, { error: "Not Found" });
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
			/hey/i,
		);
	} catch (e) {
		throw e;
	} finally {
		srv?.ac?.abort();
	}

	return srv?.server?.finished;
});

Deno.test("method catch-all resolves globally last", async () => {
	let srv: Srv | null = null;

	const app = demino();
	app.get("/", () => "home");
	app.all("/flipperial/*", () => "static");
	// legacy method-specific catch-all - must NOT shadow the .all() routes above
	app.get("*", () => {
		throw createHttpError(HTTP_STATUS.NOT_FOUND);
	});

	try {
		srv = await startTestServer(app);

		// real .all() routes win over the GET "*" catch-all
		await assertResp(fetch(`${srv.base}/flipperial/index.html`), 200, "static");
		await assertResp(fetch(`${srv.base}/flipperial/`), 200, "static");

		// exact/real routes unaffected
		await assertResp(fetch(`${srv.base}`), 200, "home");

		// catch-all still fires for genuinely unmatched paths
		await assertResp(fetch(`${srv.base}/whatever`), 404);

		// a "*" on GET must not turn an unmatched HEAD into 405
		// (HEAD has no body, so pass `false` to skip the default 404 body match)
		await assertResp(
			fetch(`${srv.base}/whatever`, { method: "HEAD" }),
			404,
			false,
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

	const methods = ["get", "post", "put", "delete", "patch"] as const;
	const app = demino();
	for (const method of methods) {
		(app[method] as Demino["get"])("/", () => method);
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

	app.get("/a/static", (_r, _i, _c) => "a/static");
	app.get("/a/[name]", (_r, _i, c) => "a/name: " + c.params.name);

	// parametrized will always win as "static" is validly resolved as param
	app.get("/b/[name]", (_r, _i, c) => "b/name: " + c.params.name);
	app.get("/b/static", (_r, _i, _c) => "b/static"); // never reached

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
		...({} as unknown as Logger),
		access: async ({ req, status }) => {
			// intentionally sleeping — must not prevent responding. Sleep
			// duration must be comfortably longer than the time taken for the
			// 4 fetches below so the assertion at length === 0 is reliable.
			await sleep(500);
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
		await sleep(750);

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

// Captures the `error` and `access` log channels into arrays (mirrors the
// `access log` test above; NOT usable via `runTestServerTests`, which force-calls
// `app.logger(null)`).
function capturingLogger(): {
	logger: DeminoLogger;
	errors: { status: number; method: string; url: string; ip: string; error: string }[];
	access: { req: Request; status: number }[];
} {
	// deno-lint-ignore no-explicit-any
	const errors: any[] = [];
	// deno-lint-ignore no-explicit-any
	const access: any[] = [];
	return {
		logger: {
			...({} as unknown as Logger),
			error: (v: unknown) => errors.push(v),
			access: (d: unknown) => access.push(d),
		},
		errors,
		access,
	};
}

// A thrown 404 from a matched `*` catch-all must NOT pollute the error log (it's
// the carsinc SEO-redirect / scanner case) — it belongs in the access log, which
// carries the URL.
Deno.test("thrown 404 from a catch-all is not error-logged", async () => {
	let srv: Srv | null = null;
	const { logger, errors, access } = capturingLogger();
	const app = demino("", [], { logger });
	app.get("*", () => {
		throw createHttpError(HTTP_STATUS.NOT_FOUND);
	});
	try {
		srv = await startTestServer(app);
		const res = await fetch(`${srv.base}/wp-login.php`);
		assertEquals(res.status, 404);
		await res.text();
		// no error-log noise...
		assertEquals(errors.length, 0);
		// ...but the access log saw it, with the URL
		assertEquals(access.length, 1);
		assertEquals(new URL(access[0].req.url).pathname, "/wp-login.php");
	} finally {
		srv?.ac?.abort();
	}
	return srv?.server?.finished;
});

// A 5xx is error-logged exactly ONCE (regression test for the old double-log),
// with request context, and the original throw preserved (via `.cause`) as a
// stringified stack.
Deno.test("thrown 5xx is error-logged once, with request context", async () => {
	let srv: Srv | null = null;
	const { logger, errors } = capturingLogger();
	const app = demino("", [], { logger });
	app.get("/boom", () => {
		throw new Error("kaboom");
	});
	try {
		srv = await startTestServer(app);
		const res = await fetch(`${srv.base}/boom`);
		assertEquals(res.status, 500);
		await res.text();
		assertEquals(errors.length, 1); // once, not twice
		const e = errors[0];
		assertEquals(e.status, 500);
		assertEquals(e.method, "GET");
		assertEquals(new URL(e.url).pathname, "/boom");
		assertEquals(typeof e.ip, "string");
		assertEquals(typeof e.error, "string");
		assertEquals(e.error.includes("kaboom"), true); // original preserved via cause
	} finally {
		srv?.ac?.abort();
	}
	return srv?.server?.finished;
});

// A thrown 4xx (403) is a client fault — not error-logged (read it from the
// access log).
Deno.test("thrown 4xx (403) is not error-logged", async () => {
	let srv: Srv | null = null;
	const { logger, errors } = capturingLogger();
	const app = demino("", [], { logger });
	app.get("/secret", () => {
		throw createHttpError(403);
	});
	try {
		srv = await startTestServer(app);
		const res = await fetch(`${srv.base}/secret`);
		assertEquals(res.status, 403);
		await res.text();
		assertEquals(errors.length, 0);
	} finally {
		srv?.ac?.abort();
	}
	return srv?.server?.finished;
});

// A 5xx originating in dispatch (501 for an unknown method) never enters the
// matched-handler catch, yet is now error-logged WITH context (previously: no URL).
Deno.test("5xx from dispatch (501) is error-logged with context", async () => {
	let srv: Srv | null = null;
	const { logger, errors } = capturingLogger();
	const app = demino("", [], { logger });
	app.get("/", () => "ok");
	try {
		srv = await startTestServer(app);
		const res = await fetch(`${srv.base}/`, { method: "PROPFIND" });
		assertEquals(res.status, 501);
		await res.text();
		assertEquals(errors.length, 1);
		const e = errors[0];
		assertEquals(e.status, 501);
		assertEquals(e.method, "PROPFIND");
		assertEquals(new URL(e.url).pathname, "/");
	} finally {
		srv?.ac?.abort();
	}
	return srv?.server?.finished;
});

runTestServerTests([
	{
		name: "context contains matched route definition",
		fn: async ({ app, base }) => {
			app.get("/", () => "hello");
			app.get("/[slug]", (_r, _i, c) => c.route);
			await assertResp(fetch(`${base}/a`), 200, "/[slug]");
		},
	},
	{
		name: "global middleware can be passed after local",
		fn: async ({ app, base }) => {
			app.get(
				"/foo",
				(_r, _i, c) => {
					c.locals.local = 1;
				},
				(_r, _i, c) => c.locals,
			);

			app.use("/foo", (_r, _i, c) => {
				c.locals.routeGlobal = 1;
			});

			app.use("/foo", (_r, _i, c) => {
				c.locals.global = 1;
			});

			await assertResp(fetch(`${base}/foo`), 200, {
				local: 1,
				routeGlobal: 1,
				global: 1,
			});
		},
	},
	{
		name: "context logger",
		fn: async ({ app, base }) => {
			let _log: unknown[] = [];
			const logger = {
				debug: (...args: unknown[]) => _log.push(...args),
			} as unknown as DeminoLogger;

			app
				.get("/hey", () => "ho")
				.use((_r, _i, c) => {
					c.getLogger()?.debug?.("foo", "bar", "baz");
				})
				.logger(logger);

			await assertResp(fetch(`${base}/hey`), 200, "ho");
			assertEquals(_log, ["foo", "bar", "baz"]);

			// now reset and no more logs...
			app.logger(null);
			_log = [];
			await assertResp(fetch(`${base}/hey`), 200, "ho");
			assertEquals(_log, []);
		},
	},
	{
		name: "app info",
		raw: true,
		fn: () => {
			const noop = () => undefined;

			const app = demino("/mount");
			app.use(noop);
			app.use("/foo", noop);
			app.get("/foo", [noop, noop], () => "bar");
			app.post("/foo", [noop, noop, noop], () => "bar");

			app.use("/bar", noop); // no record as no route handler exists

			app.all("/baz", noop);

			assertEquals(app.info(), {
				routes: {
					"/mount/foo": {
						GET: { localMiddlewaresCount: 2, globalMiddlewaresCount: 1 },
						HEAD: { localMiddlewaresCount: 2, globalMiddlewaresCount: 1 },
						POST: { localMiddlewaresCount: 3, globalMiddlewaresCount: 1 },
					},
					"/mount/baz": {
						ALL: { globalMiddlewaresCount: 0, localMiddlewaresCount: 0 },
						HEAD: { localMiddlewaresCount: 0, globalMiddlewaresCount: 0 },
					},
				},
				globalAppMiddlewaresCount: 1,
			});
		},
		// only: true,
	},
	{
		name: "app getOptions",
		fn: ({ app, base: _base }) => {
			assertEquals(app.getOptions().noXPoweredBy, true);
			assertEquals(app.getOptions().errorHandler, undefined);
		},
		// only: true,
		appOptions: {
			noXPoweredBy: true,
		},
	},
	{
		name: "app locals",
		fn: async ({ app, base }) => {
			//
			let log: unknown[] = [];
			app.get("/", (_r, _i, c) => {
				// visible from inside the handler
				log.push(c.appLocals);
			});

			// read
			assertEquals(app.locals.foo, "bar");
			assertEquals(app.locals.baz, undefined);

			await assertResp(fetch(`${base}/`), 204);
			assertEquals(log, [{ foo: "bar" }]);

			// write
			app.locals.baz = "bat";
			assertEquals(app.locals.baz, "bat");

			//
			log = []; // reset
			await assertResp(fetch(`${base}/`), 204);
			assertEquals(log, [{ foo: "bar", baz: "bat" }]);
		},
		// only: true,
		appLocals: {
			foo: "bar",
		},
	},
	{
		name: "app locals reassignment warns",
		fn: async ({ app, base }) => {
			let log: unknown[] = [];
			app.get("/", (_r, _i, c) => {
				log.push(c.appLocals);
			});

			// Initial state
			assertEquals(app.locals.foo, "bar");
			await assertResp(fetch(`${base}/`), 204);
			assertEquals(log, [{ foo: "bar" }]);

			// Reassignment is ignored (warning logged)
			app.locals = { different: "object" };

			// Original object still used
			log = [];
			await assertResp(fetch(`${base}/`), 204);
			assertEquals(log, [{ foo: "bar" }]);
			assertEquals(app.locals.foo, "bar");
		},
		appLocals: {
			foo: "bar",
		},
	},
]);
