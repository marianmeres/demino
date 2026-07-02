import { assertEquals } from "@std/assert";
import { demino, type DeminoLogger } from "../src/demino.ts";
import { startTestServer } from "./_utils.ts";

Deno.test("a throwing custom error handler does not escape (falls back + still access-logs)", async () => {
	const accessStatuses: number[] = [];
	const logger: DeminoLogger = {
		debug() {},
		log() {},
		warn() {},
		error() {}, // swallow the secondary-failure error log
		access: (d) => accessStatuses.push(d.status),
	};

	const app = demino("", [], { logger });
	// error handler itself throws — must not bubble out of _app
	app.error(() => {
		throw new Error("error handler boom");
	});
	app.get("/x", () => {
		throw new Error("original failure");
	});

	const srv = await startTestServer(app);
	try {
		const r = await fetch(`${srv.base}/x`);
		await r.text();
		// fell back to a proper 500 instead of a dropped/unhandled request
		assertEquals(r.status, 500);
		// and the access log still fired for the request (the discriminator: without
		// the guard the throw escapes before the access-log call)
		assertEquals(accessStatuses.at(-1), 500);
	} finally {
		srv.ac.abort();
		await srv.server.finished;
	}
});
