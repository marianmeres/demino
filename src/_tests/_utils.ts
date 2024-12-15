// deno-lint-ignore-file no-explicit-any

import { assert, assertEquals, assertMatch } from "@std/assert";
import { isPlainObject } from "../utils/is-plain-object.ts";

export const TEST_PORT = 9876;

/** Start test server with custom return data suitable for testing */
export async function startTestServer(
	handler: Deno.ServeHandler,
	port = TEST_PORT
) {
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

/** DRY */
export async function assertResp(
	resp: Response | Promise<Response>,
	status: number = 200,
	textCheck?: RegExp | object | boolean | string,
	headersCheck?: Record<string, string | RegExp>
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
	} else if (isPlainObject(textCheck)) {
		assertEquals(JSON.parse(text), textCheck);
	} else if (textCheck !== undefined) {
		assertEquals(text, textCheck as any);
	}

	Object.entries(headersCheck || {}).forEach(([k, v]) => {
		if (v instanceof RegExp) {
			assertMatch(resp.headers.get(k)!, v);
		} else {
			assertEquals(resp.headers.get(k)!, v);
		}
	});

	return resp;
}
