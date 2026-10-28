import assert from "node:assert/strict";
import { test } from "node:test";
import { demino, type DeminoLogger } from "../src/demino.ts";
import { startTestServer } from "./_utils.ts";

test("a throwing custom error handler does not escape (falls back + still access-logs)", async () => {
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
		assert.equal(r.status, 500);
		// and the access log still fired for the request (the discriminator: without
		// the guard the throw escapes before the access-log call)
		assert.equal(accessStatuses.at(-1), 500);
	} finally {
		await srv.close();
	}
});
