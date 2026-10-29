import assert from "node:assert/strict";
import { test } from "node:test";
import { type DeminoLogger, demino } from "../src/demino.ts";

test("app.head() routes its warning through the configurable logger (not console)", () => {
	const warns: string[] = [];
	const logger: DeminoLogger = {
		debug() {},
		log() {},
		error() {},
		warn: (...a: unknown[]) => warns.push(a.map(String).join(" ")),
	};

	const app = demino("", [], { logger });
	app.head("/x", () => "x");

	assert.ok(
		warns.some((w) => /HEAD/i.test(w)),
		`expected a HEAD warning via the logger, got: ${JSON.stringify(warns)}`,
	);
});
