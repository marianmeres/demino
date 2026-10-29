/**
 * Manifest sync: `package.json` (npm, the manifest of record) and `deno.json`
 * (JSR) describe the same package, so the two cannot drift silently.
 *
 *  - `package.json` is the published manifest and the only one with a
 *    `version`; `deno.json` carries none (`release` bumps the first manifest
 *    with a version, JSR gets it via `deno publish --set-version`);
 *  - every `package.json` dependency is a `deno.json` import with the same
 *    name and the same `^x.y.z` range;
 *  - every runtime import in `deno.json` (`jsr:`/`npm:` specifier) is a
 *    `package.json` dependency, except Deno-side tooling that is never imported
 *    from `src/` (see `DENO_ONLY`) and optional peers (see `OPTIONAL_PEERS`),
 *    which are an optional `peerDependencies` entry plus a `devDependencies`
 *    one with the same range;
 *  - `deno.json` keeps `nodeModulesDir: "none"` - with a `package.json` present
 *    `deno test` otherwise resolves `node:*` types from a local `node_modules`
 *    and fails on `npm:@types/node`;
 *  - the `deno.json` exports map is the documented one (`.`, the two adapters,
 *    the four barrels), every subpath a flat shim `src/<name>.ts`, and the
 *    `package.json` exports map is its `dist/` twin (`tsc` emits `src/x.ts` to
 *    `dist/x.js` + `dist/x.d.ts`); each barrel shim re-exports exactly its
 *    directory barrel;
 *  - a prerelease goes to npm under the `next` dist-tag (`publish:next`), never
 *    `latest` - `publish:all` keeps npm's default tag; both then publish to JSR
 *    with the `package.json` version, and no script is named `publish` (an npm
 *    lifecycle hook: `pnpm publish` would run it).
 *
 * Runs the same on Deno and Node (`node:test`).
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as middlewareBarrel from "../src/middleware/mod.ts";
import * as middlewareShim from "../src/middleware.ts";
import * as miscBarrel from "../src/misc/mod.ts";
import * as miscShim from "../src/misc.ts";
import * as routerBarrel from "../src/router/mod.ts";
import * as routerShim from "../src/router.ts";
import * as utilsBarrel from "../src/utils/mod.ts";
import * as utilsShim from "../src/utils.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** `deno.json` import keys that have no npm counterpart on purpose. */
const DENO_ONLY: RegExp[] = [
	// `./mcp.ts` generator - a repo tool, not shipped
	/^@marianmeres\/mcp-server\//,
	// Deno-side test helpers; the portability guard keeps them out of `src/`
	/^@std\//,
];

/**
 * Runtime imports the npm package declares as optional peers (e.g. `ws` for
 * the Node adapter's WebSocket upgrades); `devDependencies` carries them too,
 * for the tests and `tsc`.
 */
const OPTIONAL_PEERS = new Set<string>(["ws"]);

interface PackageJson {
	name: string;
	version?: string;
	private?: boolean;
	type?: string;
	main?: string;
	types?: string;
	exports?: Record<string, { types: string; import: string }>;
	files?: string[];
	scripts?: Record<string, string>;
	dependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	peerDependenciesMeta?: Record<string, { optional?: boolean }>;
	devDependencies?: Record<string, string>;
}

interface DenoJson {
	name?: string;
	version?: string;
	exports?: string | Record<string, string>;
	nodeModulesDir?: string;
	imports?: Record<string, string>;
	tasks?: Record<string, string>;
}

interface DenoImport {
	/** import map key, e.g. `@marianmeres/mcp-server/types` */
	key: string;
	scheme: "jsr" | "npm";
	/** package name, e.g. `@marianmeres/mcp-server` */
	name: string;
	/** version range as written, e.g. `^1.3.2` */
	range: string;
}

function readJson<T>(file: string): T {
	return JSON.parse(readFileSync(join(ROOT, file), "utf8")) as T;
}

/** `jsr:@scope/name@^1.2.3[/subpath]` or `npm:name@^1.2.3[/subpath]` */
const SPECIFIER = /^(jsr|npm):((?:@[^/@]+\/)?[^/@]+)@([^/]+)(?:\/.*)?$/;

function parseImports(deno: DenoJson): DenoImport[] {
	const out: DenoImport[] = [];
	for (const [key, spec] of Object.entries(deno.imports ?? {})) {
		const m = SPECIFIER.exec(spec);
		assert.ok(m, `deno.json import "${key}": unrecognized specifier "${spec}"`);
		out.push({ key, scheme: m[1] as "jsr" | "npm", name: m[2], range: m[3] });
	}
	return out;
}

const pkg = readJson<PackageJson>("package.json");
const deno = readJson<DenoJson>("deno.json");
const denoImports = parseImports(deno);
const dependencies = pkg.dependencies ?? {};
const devDependencies = pkg.devDependencies ?? {};

test("manifest-sync: package.json is the published manifest, the only one with a version", () => {
	assert.equal(pkg.name, "@marianmeres/demino");
	assert.notEqual(pkg.private, true, "the repo root is what npm gets");
	assert.equal(pkg.type, "module");
	assert.match(pkg.version ?? "", /^\d+\.\d+\.\d+(-[\w.]+)?$/, "package.json version");
	assert.equal(deno.name, pkg.name, "deno.json and package.json name one package");
	assert.equal(deno.version, undefined, "deno.json must not carry a version");
	assert.ok(pkg.files?.includes("dist"), 'package.json "files" must include dist');
	for (const dir of ["src", "tests", "scripts", "tmp"]) {
		assert.ok(
			!pkg.files?.includes(dir),
			`package.json "files" must not include ${dir}`,
		);
	}
});

test('manifest-sync: deno.json keeps nodeModulesDir "none"', () => {
	assert.equal(deno.nodeModulesDir, "none");
});

test("manifest-sync: reads a real dependency set (sanity)", () => {
	assert.ok(Object.keys(dependencies).length > 0, "package.json has no dependencies");
	assert.ok(denoImports.length > 0, "deno.json has no imports");
});

test("manifest-sync: every package.json dependency is a deno.json import with the same range", () => {
	for (const [name, range] of Object.entries(dependencies)) {
		const found = denoImports.find((i) => i.key === name);
		assert.ok(found, `package.json dependency "${name}" has no deno.json import`);
		assert.equal(
			found.name,
			name,
			`deno.json import "${name}" maps to another package`,
		);
		assert.equal(
			found.range,
			range,
			`"${name}": deno.json has ${found.range}, package.json has ${range}`,
		);
	}
});

test("manifest-sync: every runtime import in deno.json is a package.json dependency", () => {
	for (const { key, name, range } of denoImports) {
		if (DENO_ONLY.some((re) => re.test(key))) continue;
		const sections: [string, Record<string, string>][] = OPTIONAL_PEERS.has(name)
			? [
					["peerDependencies", pkg.peerDependencies ?? {}],
					["devDependencies", devDependencies],
				]
			: [["dependencies", dependencies]];
		for (const [where, section] of sections) {
			assert.ok(
				name in section,
				`deno.json import "${key}" (${name}@${range}) is missing from package.json ${where}`,
			);
			assert.equal(
				section[name],
				range,
				`"${name}": deno.json has ${range}, package.json ${where} has ${
					section[name]
				}`,
			);
		}
	}
});

test("manifest-sync: optional peers are optional and not also runtime dependencies", () => {
	for (const name of OPTIONAL_PEERS) {
		assert.ok(
			!(name in dependencies),
			`"${name}" is an optional peer and must not be in package.json dependencies`,
		);
		assert.equal(
			pkg.peerDependenciesMeta?.[name]?.optional,
			true,
			`"${name}" peer must be marked optional`,
		);
	}
});

// ---------------------------------------------------------------------------
// exports map and flat shims
// ---------------------------------------------------------------------------

/**
 * The public subpaths: `.`, the two runtime adapters and the four barrels
 * `AGENTS.md`/`mcp.ts` promise. Both manifests' exports maps are checked
 * against it, so a change here is a change of the published surface.
 */
const EXPORTS: Record<string, string> = {
	".": "./src/mod.ts",
	"./deno": "./src/deno.ts",
	"./node": "./src/node.ts",
	"./middleware": "./src/middleware.ts",
	"./misc": "./src/misc.ts",
	"./router": "./src/router.ts",
	"./utils": "./src/utils.ts",
};

test("manifest-sync: deno.json exports map is the documented one", () => {
	assert.deepEqual(deno.exports, EXPORTS);
});

test("manifest-sync: every export is an existing flat shim src/<name>.ts", () => {
	const exportsMap = deno.exports;
	assert.ok(typeof exportsMap === "object" && exportsMap, "exports must be a map");
	for (const [key, target] of Object.entries(exportsMap)) {
		// `.` is `src/mod.ts`, `./x` is `src/x.ts`
		const name = key === "." ? "mod" : key.replace(/^\.\//, "");
		assert.equal(
			target,
			`./src/${name}.ts`,
			`exports["${key}"] is not the flat shim`,
		);
		assert.ok(
			existsSync(join(ROOT, target)),
			`exports["${key}"]: ${target} does not exist`,
		);
	}
});

test("manifest-sync: package.json exports map is the dist/ twin of deno.json's", () => {
	const expected = Object.fromEntries(
		Object.entries(EXPORTS).map(([key, target]) => {
			const base = target.replace(/^\.\/src\//, "./dist/").replace(/\.ts$/, "");
			return [key, { types: `${base}.d.ts`, import: `${base}.js` }];
		}),
	);
	assert.deepEqual(pkg.exports, expected);
	assert.equal(pkg.main, "dist/mod.js");
	assert.equal(pkg.types, "dist/mod.d.ts");
});

test("manifest-sync: barrel shims re-export exactly their directory barrel", () => {
	const pairs: Record<string, [object, object]> = {
		middleware: [middlewareShim, middlewareBarrel],
		misc: [miscShim, miscBarrel],
		router: [routerShim, routerBarrel],
		utils: [utilsShim, utilsBarrel],
	};
	for (const [name, [shim, barrel]] of Object.entries(pairs)) {
		assert.ok(Object.keys(barrel).length > 0, `src/${name}/mod.ts exports nothing?`);
		assert.deepEqual(
			Object.keys(shim).sort(),
			Object.keys(barrel).sort(),
			`src/${name}.ts and src/${name}/mod.ts export different names`,
		);
	}
});

// ---------------------------------------------------------------------------
// publish scripts
// ---------------------------------------------------------------------------

test("manifest-sync: publish:next sends npm the next dist-tag, publish:all does not", () => {
	const scripts = pkg.scripts ?? {};
	assert.equal(
		scripts["publish"],
		undefined,
		'no "publish" script (npm lifecycle hook)',
	);
	assert.match(
		scripts["publish:next"] ?? "",
		/^pnpm publish --tag next\b.* && pnpm run publish:jsr$/,
	);
	assert.match(scripts["publish:all"] ?? "", /^pnpm publish && pnpm run publish:jsr$/);
	assert.match(
		scripts["publish:jsr"] ?? "",
		/deno publish --set-version "\$npm_package_version"$/,
	);
	assert.equal(
		deno.tasks,
		undefined,
		"deno.json has no tasks - package.json scripts are the entry points",
	);
});
