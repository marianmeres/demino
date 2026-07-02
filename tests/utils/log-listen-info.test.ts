import { assert } from "@std/assert";
import { logListenInfo } from "../../src/utils/log-listen-info.ts";

/** Capture console.log output produced while running `fn`. */
function captureLog(fn: () => void): string[] {
	const logs: string[] = [];
	const orig = console.log;
	console.log = (...a: unknown[]) => {
		logs.push(a.map(String).join(" "));
	};
	try {
		fn();
	} finally {
		console.log = orig;
	}
	return logs;
}

Deno.test("logListenInfo: IPv6 literal host is bracketed in the URL", () => {
	const logs = captureLog(() =>
		logListenInfo({ hostname: "::1", port: 8000, transport: "tcp" } as Deno.NetAddr)
	);
	assert(
		logs.some((l) => l.includes("[::1]:8000")),
		`expected a bracketed IPv6 URL, got:\n${logs.join("\n")}`,
	);
	// must NOT emit the malformed unbracketed form
	assert(
		!logs.some((l) => l.includes("://::1:")),
		`emitted a malformed IPv6 URL:\n${logs.join("\n")}`,
	);
});

Deno.test("logListenInfo: '::' is treated as all-interfaces (lists localhost)", () => {
	const logs = captureLog(() =>
		logListenInfo({ hostname: "::", port: 9000, transport: "tcp" } as Deno.NetAddr)
	);
	assert(
		logs.some((l) => l.includes("localhost:9000")),
		`expected localhost to be listed for '::', got:\n${logs.join("\n")}`,
	);
});
