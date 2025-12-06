import { assert, assertEquals, assertMatch } from "@std/assert";
import { isPlainObject } from "../src/utils/is-plain-object.ts";
import {
	type Demino,
	demino,
	type DeminoAppLocals,
	type DeminoOptions,
} from "../src/demino.ts";
import { createHttpApi } from "@marianmeres/http-utils";

const hostname = "127.0.0.1";

// Helper to find available port
function getAvailablePort(): number {
	const listener = Deno.listen({ hostname, port: 0 });
	const port = (listener.addr as Deno.NetAddr).port;
	listener.close();
	return port;
}

/** Start test server with custom return data suitable for testing */
export async function startTestServer(handler: Deno.ServeHandler) {
	const port = getAvailablePort();
	const ac = new AbortController();
	// By default `Deno.serve` prints the message ... If you like to
	// change this behavior, you can specify a custom `onListen` callback.
	const server = await Deno.serve(
		{ hostname, port, signal: ac.signal, onListen(_) {} },
		handler,
	);
	// server.finished.then(() => console.log("Server closed"));
	return { port, ac, server, base: `http://localhost:${port}` };
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
			def.raw
				? () => def.fn({} as unknown as TestServerTestOpts)
				: async () => {
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
						srv?.ac?.abort();
					}
					return srv?.server?.finished;
				},
		);
	}
}
