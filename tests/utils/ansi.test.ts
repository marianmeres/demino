import { assertEquals } from "@std/assert";
import { colorEnabled, green, red } from "../../src/utils/ansi.ts";

Deno.test("ansi: wraps in SGR codes and honours NO_COLOR at call time", () => {
	const had = "NO_COLOR" in process.env;
	const prev = process.env.NO_COLOR;
	try {
		delete process.env.NO_COLOR;
		assertEquals(colorEnabled(), true);
		assertEquals(green("x"), "\x1b[32mx\x1b[39m");
		assertEquals(red("x"), "\x1b[31mx\x1b[39m");

		// presence alone disables, whatever the value (no-color.org)
		process.env.NO_COLOR = "";
		assertEquals(colorEnabled(), false);
		assertEquals(green("x"), "x");
		assertEquals(red("x"), "x");

		process.env.NO_COLOR = "1";
		assertEquals(green("x"), "x");
	} finally {
		if (had) process.env.NO_COLOR = prev;
		else delete process.env.NO_COLOR;
	}
});
