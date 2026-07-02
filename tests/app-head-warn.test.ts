import { assert } from "@std/assert";
import { demino, type DeminoLogger } from "../src/demino.ts";

Deno.test("app.head() routes its warning through the configurable logger (not console)", () => {
	const warns: string[] = [];
	const logger: DeminoLogger = {
		debug() {},
		log() {},
		error() {},
		warn: (...a: unknown[]) => warns.push(a.map(String).join(" ")),
	};

	const app = demino("", [], { logger });
	app.head("/x", () => "x");

	assert(
		warns.some((w) => /HEAD/i.test(w)),
		`expected a HEAD warning via the logger, got: ${JSON.stringify(warns)}`,
	);
});
