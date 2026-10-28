import { assert, assertEquals, assertMatch } from "@std/assert";
import { isPlainObject } from "../src/utils/is-plain-object.ts";
import {
	type Demino,
	demino,
	type DeminoAppLocals,
	type DeminoOptions,
	type DeminoServeHandler,
} from "../src/demino.ts";
import { createHttpApi } from "@marianmeres/http-utils";
import { serve } from "../src/adapters/deno.ts";

const hostname = "127.0.0.1";

/** A server started by {@linkcode startTestServer}. */
export interface TestServer {
	/** The real bound port (the server listens on `port: 0`). */
	port: number;
	/**
	 * `http://localhost:<port>` - deliberately `localhost`, not the bound
	 * `127.0.0.1`: tests rely on the two being different host names (proxy
	 * allowlists, `ctx.url` assertions).
	 */
	base: string;
	/**
	 * Closes the server and all of its connections (forceful, via the abort
	 * signal); resolves once the server is fully closed.
	 */
	close: () => Promise<void>;
}

/**
 * Starts a test server for the given handler through the runtime adapter (the
 * harness is the adapter's first consumer), silently, on a free port.
 */
export async function startTestServer(
	handler: DeminoServeHandler,
): Promise<TestServer> {
	// Closed through the abort signal, not `shutdown()`: tests may leave a request
	// in flight on purpose (e.g. an upstream still sleeping after the proxy timed
	// out) and a graceful shutdown would wait for it forever. Aborting closes the
	// server and all its connections - exactly what the previous harness did.
	const ac = new AbortController();
	const srv = await serve(handler, {
		hostname,
		port: 0,
		signal: ac.signal,
		onListen() {},
	});
	return {
		port: srv.port,
		base: `http://localhost:${srv.port}`,
		close: async () => {
			ac.abort();
			await srv.finished;
		},
	};
}

/** DRY */
export async function assertResp(
	resp: Response | Promise<Response>,
	status: number = 200,
	textCheck?: RegExp | object | boolean | string,
	headersCheck?: Record<string, string | boolean | RegExp>,
) {
	resp = await resp;
	assertEquals(resp.status, status);
	const text = await resp.text();

	if (textCheck === undefined && status === 404) {
		textCheck = /not found/i;
	}

	if (textCheck instanceof RegExp) {
		assertMatch(text, textCheck);
	} else if (typeof textCheck === "boolean") {
		if (textCheck) assert(text, "text() is not truthy");
		else assert(!text, "text() is not falsy");
	} else if (isPlainObject(textCheck) || Array.isArray(textCheck)) {
		assertEquals(JSON.parse(text), textCheck);
	} else if (textCheck !== undefined) {
		assertEquals(text, textCheck as string);
	}

	Object.entries(headersCheck || {}).forEach(([k, v]) => {
		if (v instanceof RegExp) {
			assertMatch(resp.headers.get(k)!, v);
		} else if (typeof v === "boolean") {
			if (v) {
				assert(resp.headers.has(k), `Expecting headers to HAVE a "${k}" key`);
			} else {
				assert(
					!resp.headers.has(k),
					`Expecting headers to NOT HAVE a "${k}" key, got: "${
						resp.headers.get(
							k,
						)
					}"`,
				);
			}
		} else {
			assertEquals(
				resp.headers.get(k)!,
				v,
				`Expected: "${k}: ${v}", Actual: "${k}: ${resp.headers.get(k)}"`,
			);
		}
	});

	return resp;
}

/** Options passed to test functions */
export interface TestServerTestOpts {
	srv: Awaited<ReturnType<typeof startTestServer>>;
	base: string;
	app: Demino;
	get: ReturnType<typeof createHttpApi>["get"];
	post: ReturnType<typeof createHttpApi>["post"];
	put: ReturnType<typeof createHttpApi>["put"];
	patch: ReturnType<typeof createHttpApi>["patch"];
	del: ReturnType<typeof createHttpApi>["del"];
}

//
export function runTestServerTests(
	tests: {
		name: string;
		fn: (opts: TestServerTestOpts) => void | Promise<void>;
		only?: boolean;
		ignore?: boolean;
		raw?: boolean;
		appOptions?: DeminoOptions;
		appLocals?: DeminoAppLocals;
	}[],
) {
	for (const def of tests) {
		const { name, ignore, only } = def;
		if (typeof def.fn !== "function") continue;
		Deno.test(
			{ name, ignore, only },
			def.raw ? () => def.fn({} as unknown as TestServerTestOpts) : async () => {
				let srv: Awaited<ReturnType<typeof startTestServer>> | null = null;
				try {
					const app = demino("", [], def.appOptions, def.appLocals);
					app.logger(null);
					srv = await startTestServer(app);
					const api = createHttpApi(srv.base);
					// deno-lint-ignore no-explicit-any
					const opts = { srv, app, ...api, base: srv.base } as any;
					await def.fn(opts as TestServerTestOpts);
				} catch (e) {
					throw e;
				} finally {
					await srv?.close();
				}
			},
		);
	}
}
