/**
 * Builds the npm package into `.npm-dist/` (`deno task npm:build`).
 *
 * Build script: runs on Deno only and ships nothing of itself, so `Deno.*` is
 * fine here (the portability guard walks `src/` only).
 *
 * The entry points are derived from the `deno.json` exports map so the two
 * cannot drift: npmbuild maps an entry `x` to `src/x.ts` and `exports["./x"]`
 * (`mod` to `.`), which is why every subpath is a flat shim `src/<name>.ts`.
 */

import { npmBuild, versionizeDeps } from "@marianmeres/npmbuild";

const denoJson = JSON.parse(Deno.readTextFileSync("deno.json"));
const devPackageJson = JSON.parse(Deno.readTextFileSync("package.json"));

// "." -> "mod", "./x" -> "x"; each must be the flat shim `./src/<name>.ts`
const exportsMap: Record<string, string> = denoJson.exports;
const entryPoints = Object.entries(exportsMap).map(([key, target]) => {
	const name = key === "." ? "mod" : key.replace(/^\.\//, "");
	if (target !== `./src/${name}.ts`) {
		throw new Error(
			`deno.json exports "${key}" must point at "./src/${name}.ts" (flat shim), got "${target}"`,
		);
	}
	return name;
});

/** `name@range` -> `[name, range]` (range from `deno.json` imports). */
function versionized(dep: string): [string, string] {
	const [spec] = versionizeDeps([dep], denoJson);
	const at = spec.lastIndexOf("@");
	if (at <= 0) throw new Error(`deno.json imports: no version for "${dep}"`);
	return [spec.slice(0, at), spec.slice(at + 1)];
}

// `ws` is imported lazily by the Node adapter for WebSocket upgrades; without
// it the server still runs (HTTP only, one warning) - an optional peer.
const [wsName, wsRange] = versionized("ws");

// The build's `tsc` pass must resolve `node:*` and `import("ws")` inside
// `.npm-dist/`; npm installs devDependencies alongside the runtime deps and
// ignores them in consumers. Ranges come from the dev manifest (one source).
const buildTypes = ["@types/node", "@types/ws"];
const devDependencies = Object.fromEntries(
	buildTypes.map((name) => {
		const range = devPackageJson.devDependencies?.[name];
		if (!range) throw new Error(`package.json devDependencies: "${name}" missing`);
		return [name, range];
	}),
);

await npmBuild({
	name: denoJson.name,
	version: denoJson.version,
	repository: denoJson.name.replace(/^@/, ""),
	entryPoints,
	dependencies: versionizeDeps(
		[
			"@marianmeres/clog",
			"@marianmeres/http-utils",
			"@marianmeres/midware",
			"@marianmeres/simple-router",
			"mrmime",
		],
		denoJson,
	),
	peerDependencies: { [wsName]: wsRange },
	peerDependenciesMeta: { [wsName]: { optional: true } },
	packageJsonOverrides: {
		// the emitted JS uses `Readable.toWeb` (17+), `Headers.getSetCookie` (19.7+),
		// `readdirSync({ recursive })` (20.1+) and the global `WebSocket` (22)
		engines: { node: ">=22" },
		keywords: [
			"http",
			"router",
			"middleware",
			"deno",
			"node",
			"bun",
			"web-standards",
		],
		devDependencies,
	},
	// the sources are written strict and erasable-only; npmbuild defaults to `strict: false`
	tsconfig: {
		compilerOptions: {
			strict: true,
			erasableSyntaxOnly: true,
			verbatimModuleSyntax: true,
		},
	},
});
