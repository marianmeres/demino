import assert from "node:assert/strict";
import { test } from "node:test";
import { colorEnabled, green, red } from "../../src/utils/ansi.ts";

test("ansi: wraps in SGR codes and honours NO_COLOR at call time", () => {
	const had = "NO_COLOR" in process.env;
	const prev = process.env.NO_COLOR;
	try {
		delete process.env.NO_COLOR;
		assert.equal(colorEnabled(), true);
		assert.equal(green("x"), "\x1b[32mx\x1b[39m");
		assert.equal(red("x"), "\x1b[31mx\x1b[39m");

		// presence alone disables, whatever the value (no-color.org)
		process.env.NO_COLOR = "";
		assert.equal(colorEnabled(), false);
		assert.equal(green("x"), "x");
		assert.equal(red("x"), "x");

		process.env.NO_COLOR = "1";
		assert.equal(green("x"), "x");
	} finally {
		if (had) process.env.NO_COLOR = prev;
		else delete process.env.NO_COLOR;
	}
});
