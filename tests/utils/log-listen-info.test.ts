import { assert, assertEquals } from "@std/assert";
import { networkInterfaces } from "node:os";
import { createLogListenInfo, logListenInfo } from "../../src/utils/log-listen-info.ts";

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
	const logs = captureLog(() => logListenInfo({ hostname: "::1", port: 8000 }));
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
	const logs = captureLog(() => logListenInfo({ hostname: "::", port: 9000 }));
	assert(
		logs.some((l) => l.includes("localhost:9000")),
		`expected localhost to be listed for '::', got:\n${logs.join("\n")}`,
	);
});

Deno.test("logListenInfo: all-interfaces output lists node:os addresses, no loopback/link-local", () => {
	const lines: string[] = [];
	logListenInfo({ hostname: "0.0.0.0", port: 8000 }, { write: (l) => lines.push(l) });

	// what the function must advertise, derived from the same `node:os` data
	const expected: string[] = [];
	for (const list of Object.values(networkInterfaces())) {
		for (const iface of list ?? []) {
			// the shape the filter relies on: string family, boolean `internal`
			assert(
				iface.family === "IPv4" || iface.family === "IPv6",
				`unexpected family: ${JSON.stringify(iface.family)}`,
			);
			assertEquals(typeof iface.internal, "boolean");
			if (iface.internal || iface.address.toLowerCase().startsWith("fe80:")) {
				continue;
			}
			expected.push(iface.family === "IPv6" ? `[${iface.address}]` : iface.address);
		}
	}

	const network = lines.filter((l) => l.includes("Network:"));
	assertEquals(
		network.length,
		expected.length,
		`expected ${expected.length} network line(s), got:\n${lines.join("\n")}`,
	);
	for (const addr of expected) {
		assert(
			network.some((l) => l.includes(`http://${addr}:8000/`)),
			`missing ${addr} in:\n${network.join("\n")}`,
		);
	}
	// loopback and link-local never show up, whatever the machine has
	assert(
		!lines.some((l) =>
			l.includes("://127.") || l.includes("[::1]") ||
			l.toLowerCase().includes("fe80:")
		),
		`loopback/link-local leaked:\n${lines.join("\n")}`,
	);
});

Deno.test("logListenInfo: json 'auto' follows process.stdout.isTTY", () => {
	const lines: string[] = [];
	logListenInfo({ hostname: "127.0.0.1", port: 8000 }, {
		json: "auto",
		write: (l) => lines.push(l),
	});
	if (process.stdout.isTTY) {
		assert(
			lines.some((l) => l.includes("Demino listening")) &&
				!lines.some((l) => l.trim().startsWith("{")),
			`stdout is a tty, expected human output, got:\n${lines.join("\n")}`,
		);
	} else {
		assertEquals(
			lines.length,
			1,
			`expected one json line, got:\n${lines.join("\n")}`,
		);
		assertEquals(JSON.parse(lines[0]).event, "server.listen");
	}
});

Deno.test("logListenInfo: json mode emits a single parsable JSON line", () => {
	const lines: string[] = [];
	logListenInfo({ hostname: "0.0.0.0", port: 8000 }, {
		json: true,
		write: (l) => lines.push(l),
	});

	assertEquals(lines.length, 1, `expected exactly 1 line, got:\n${lines.join("\n")}`);

	const parsed = JSON.parse(lines[0]);
	assertEquals(parsed.level, "info");
	assertEquals(parsed.logger, "demino");
	assertEquals(parsed.event, "server.listen");
	assertEquals(parsed.hostname, "0.0.0.0");
	assertEquals(parsed.port, 8000);
	// the unspecified address is advertised as localhost (same as the human output)
	assertEquals(parsed.url, "http://localhost:8000/");
	assert(
		!isNaN(Date.parse(parsed.timestamp)),
		`invalid timestamp: ${parsed.timestamp}`,
	);
	// no ansi/%c noise in structured output
	assert(!lines[0].includes("%c"), "json line must not contain style directives");
});

Deno.test("logListenInfo: json mode brackets IPv6 and honors namespace + fields", () => {
	const lines: string[] = [];
	logListenInfo({ hostname: "::1", port: 9000 }, {
		json: true,
		namespace: "my-api",
		fields: { service: "api", level: "debug" },
		write: (l) => lines.push(l),
	});

	const parsed = JSON.parse(lines[0]);
	assertEquals(parsed.url, "http://[::1]:9000/");
	assertEquals(parsed.logger, "my-api");
	assertEquals(parsed.service, "api");
	// `fields` is merged last, so it can override built-ins
	assertEquals(parsed.level, "debug");
});

Deno.test("logListenInfo: default (no options) stays human readable", () => {
	const logs = captureLog(() =>
		logListenInfo(
			{ hostname: "127.0.0.1", port: 8000 },
		)
	);
	assert(
		logs.some((l) => l.includes("Demino listening")),
		`expected the human output, got:\n${logs.join("\n")}`,
	);
	assert(
		!logs.some((l) => l.trim().startsWith("{")),
		`must not emit json by default:\n${logs.join("\n")}`,
	);
});

Deno.test("logListenInfo: custom write sink gets plain (unstyled) human lines", () => {
	const lines: string[] = [];
	logListenInfo(
		{ hostname: "127.0.0.1", port: 8000 },
		{
			write: (l) => lines.push(l),
		},
	);
	assert(
		lines.some((l) => l.includes("http://127.0.0.1:8000/")),
		`expected the url, got:\n${lines.join("\n")}`,
	);
	assert(
		!lines.some((l) => l.includes("%c") || l.includes("color:")),
		`style directives leaked into the sink:\n${lines.join("\n")}`,
	);
});

Deno.test("createLogListenInfo: returns a preconfigured onListen callback", () => {
	const lines: string[] = [];
	const onListen = createLogListenInfo({ json: true, write: (l) => lines.push(l) });
	onListen({ hostname: "0.0.0.0", port: 3000 });
	assertEquals(JSON.parse(lines[0]).port, 3000);
});
