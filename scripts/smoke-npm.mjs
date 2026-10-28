/**
 * Smoke-imports the built npm package (`deno task npm:smoke`, or
 * `node scripts/smoke-npm.mjs` after `deno task npm:build`).
 *
 * In a throw-away project under the OS temp dir it runs
 * `npm install --install-links <.npm-dist>` - a packed copy, as a consumer
 * gets it, not a symlink into this repo - and then, on Node, inside that project:
 *
 *  - checks the installed package.json: the eight `exports` keys, the five
 *    runtime dependencies, `ws` as an optional peer, `engines.node`;
 *  - imports every subpath;
 *  - `demino()` + `serve()` from `@marianmeres/demino/node`: listens on port 0,
 *    fetches `/`, expects 200, shuts down.
 *
 * `ws` is deliberately not installed in the smoke project: the Node adapter has
 * to warn once and serve HTTP anyway (the optional-peer contract), so one such
 * warning in the output is expected.
 *
 * Repo tool, Node only (nothing here is shipped).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, ".npm-dist");
const PKG = "@marianmeres/demino";

const EXPECTED_EXPORTS = [
	".",
	"./deno",
	"./node",
	"./bun",
	"./middleware",
	"./misc",
	"./router",
	"./utils",
];
const EXPECTED_DEPENDENCIES = [
	"@marianmeres/clog",
	"@marianmeres/http-utils",
	"@marianmeres/midware",
	"@marianmeres/simple-router",
	"mrmime",
];

/** Runs inside the temp project, where the bare specifiers resolve. */
const CONSUMER = `
import assert from "node:assert/strict";
import { demino } from "${PKG}";
import { serve } from "${PKG}/node";
import * as denoAdapter from "${PKG}/deno";
import * as bunAdapter from "${PKG}/bun";
import * as middleware from "${PKG}/middleware";
import * as misc from "${PKG}/misc";
import * as router from "${PKG}/router";
import * as utils from "${PKG}/utils";

assert.equal(typeof demino, "function", "demino");
assert.equal(typeof serve, "function", "serve (node)");
assert.equal(typeof denoAdapter.serve, "function", "serve (deno)");
assert.equal(typeof bunAdapter.serve, "function", "serve (bun)");
assert.equal(typeof middleware.cors, "function", "middleware.cors");
assert.equal(typeof misc.deminoCompose, "function", "misc.deminoCompose");
assert.equal(typeof router.DeminoFixedRouter, "function", "router.DeminoFixedRouter");
assert.equal(typeof utils.logListenInfo, "function", "utils.logListenInfo");
console.log("smoke: all eight subpaths import");

const app = demino("", [], { logger: null });
app.get("/", () => "smoke ok");

console.log("smoke: (ws is not installed here - one 'upgrades are disabled' warning is expected)");
const handle = await serve(app, { port: 0, hostname: "127.0.0.1", onListen: () => {} });
try {
	assert.ok(handle.port > 0, "a real port was bound");
	const res = await fetch(handle.url);
	assert.equal(res.status, 200, "GET / status");
	assert.equal(await res.text(), "smoke ok", "GET / body");
	console.log(\`smoke: GET \${handle.url} -> 200\`);
} finally {
	await handle.shutdown();
}
console.log("smoke: shut down cleanly");
`;

function run(cmd, args, cwd) {
	console.log(`smoke: $ ${[cmd, ...args].join(" ")}`);
	execFileSync(cmd, args, { cwd, stdio: "inherit" });
}

function check(condition, what) {
	if (!condition) throw new Error(`smoke: ${what}`);
}

function checkInstalledManifest(dir) {
	const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
	check(pkg.name === PKG, `installed package is "${pkg.name}", expected "${PKG}"`);
	const exportKeys = Object.keys(pkg.exports ?? {}).sort();
	check(
		JSON.stringify(exportKeys) === JSON.stringify([...EXPECTED_EXPORTS].sort()),
		`exports keys are ${JSON.stringify(exportKeys)}`,
	);
	for (const [key, entry] of Object.entries(pkg.exports)) {
		for (const kind of ["types", "import"]) {
			check(
				typeof entry[kind] === "string" && existsSync(join(dir, entry[kind])),
				`exports["${key}"].${kind} does not exist: ${entry?.[kind]}`,
			);
		}
	}
	for (const name of EXPECTED_DEPENDENCIES) {
		check(name in (pkg.dependencies ?? {}), `runtime dependency "${name}" missing`);
	}
	check(!("ws" in (pkg.dependencies ?? {})), `"ws" must not be a runtime dependency`);
	check(typeof pkg.peerDependencies?.ws === "string", `"ws" is not a peer dependency`);
	check(pkg.peerDependenciesMeta?.ws?.optional === true, `"ws" peer is not optional`);
	check(typeof pkg.engines?.node === "string", "engines.node missing");
	console.log(
		`smoke: ${pkg.name}@${pkg.version} - exports ${exportKeys.length}/${EXPECTED_EXPORTS.length}, ` +
			`peer ws ${pkg.peerDependencies.ws} (optional), engines.node ${pkg.engines.node}`,
	);
}

check(
	existsSync(join(DIST, "package.json")),
	`${DIST} has no package.json - run \`deno task npm:build\` first`,
);

const project = mkdtempSync(join(tmpdir(), "demino-npm-smoke-"));
try {
	writeFileSync(
		join(project, "package.json"),
		JSON.stringify(
			{ name: "demino-npm-smoke", private: true, type: "module" },
			null,
			"\t",
		),
	);
	run(
		"npm",
		[
			"install",
			"--install-links",
			"--no-audit",
			"--no-fund",
			"--loglevel=error",
			DIST,
		],
		project,
	);
	checkInstalledManifest(join(project, "node_modules", PKG));
	writeFileSync(join(project, "consumer.mjs"), CONSUMER);
	run(process.execPath, ["consumer.mjs"], project);
	console.log("smoke: OK");
} finally {
	rmSync(project, { recursive: true, force: true });
}
