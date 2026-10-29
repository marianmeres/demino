/**
 * Portability guard: the invariant 2.0 exists for, enforced by the suite instead
 * of by review. Walks `src/**\/*.ts` with `node:fs`, strips comments (and, where
 * noted, string contents) and asserts:
 *
 *  (a) no runtime coupling outside `src/adapters/` - no `Deno.`, `Bun.`,
 *      `typeof Deno|Bun`, `globalThis.Deno|Bun`, `"Deno"|"Bun" in globalThis`;
 *  (b) `src/adapters/deno.ts` is the only file saying `Deno`; no file says `Bun`
 *      (not a supported runtime, so nothing in `src/` may couple to it);
 *  (c) no `@std/`, `jsr:`, `npm:` or `https:` import specifiers anywhere in `src/`;
 *  (d) erasable-only syntax - no `enum`, no `namespace`, no constructor parameter
 *      properties (Node strips types, it never checks or lowers them).
 *
 * The flat shims (`src/deno.ts`, `src/node.ts`) only re-export and therefore
 * pass (a). Runs the same on Deno and Node (`node:test`).
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");

/**
 * The one file that may say `Deno` resp. `Bun` in code (comments and strings
 * aside); `null` - no file may.
 */
const RUNTIME_OWNER: Record<"Deno" | "Bun", string | null> = {
	Deno: "src/adapters/deno.ts",
	Bun: null,
};

/** Import specifier prefixes that are not portable (Deno-only resolution). */
const FORBIDDEN_SPECIFIER = /^(@std\/|jsr:|npm:|https?:)/;

// ---------------------------------------------------------------------------
// source scanning
// ---------------------------------------------------------------------------

/** Recursively lists `*.ts` files under `dir`, sorted, absolute. */
function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) walk(path, out);
		else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(path);
	}
	return out.sort();
}

/** Two views of one source: `code` has comments blanked, `bare` also blanks string, template and regex literal bodies. Newlines and offsets are preserved, so line numbers stay valid. */
interface Scanned {
	code: string;
	bare: string;
}

const REGEX_PRECEDERS = new Set("(,=:[!&|?{};+-*%<>~^".split(""));
const REGEX_KEYWORDS = new Set([
	"return",
	"typeof",
	"instanceof",
	"in",
	"of",
	"new",
	"delete",
	"void",
	"throw",
	"case",
	"do",
	"else",
	"yield",
	"await",
]);

/**
 * A small TS-aware scanner: tracks `//` and `/* *\/` comments, `'`/`"` strings,
 * template literals (with nested `${ }` code) and regex literals (heuristic:
 * a `/` is a regex start when the previous significant token cannot end an
 * expression). Comments are blanked in both outputs, literal bodies in `bare`
 * only - the import check needs the specifier strings.
 */
function scan(src: string): Scanned {
	const n = src.length;
	const code = src.split("");
	const bare = src.split("");

	const blank = (arr: string[], from: number, to: number) => {
		for (let k = from; k < to && k < n; k++) if (arr[k] !== "\n") arr[k] = " ";
	};
	const blankBoth = (from: number, to: number) => {
		blank(code, from, to);
		blank(bare, from, to);
	};

	/** Can a `/` at `i` start a regex literal? Looks back over the comment-blanked code. */
	const regexAllowed = (i: number): boolean => {
		let j = i - 1;
		while (j >= 0 && /\s/.test(code[j])) j--;
		if (j < 0) return true;
		const prev = code[j];
		if (REGEX_PRECEDERS.has(prev)) return true;
		if (prev === "}") return true; // block end (object-literal-then-divide is rare)
		if (/[A-Za-z0-9_$]/.test(prev)) {
			let s = j;
			while (s >= 0 && /[A-Za-z0-9_$]/.test(code[s])) s--;
			return REGEX_KEYWORDS.has(src.slice(s + 1, j + 1));
		}
		return false;
	};

	/** `i` is just after the opening `/`; returns the index after the literal (or `i` if it was a division). */
	const scanRegex = (i: number): number => {
		const start = i;
		let inClass = false;
		while (i < n) {
			const c = src[i];
			if (c === "\\") {
				i += 2;
				continue;
			}
			if (c === "\n") break; // unterminated on this line: it was a division
			if (inClass) {
				if (c === "]") inClass = false;
			} else if (c === "[") {
				inClass = true;
			} else if (c === "/") {
				blank(bare, start, i);
				i++;
				while (i < n && /[a-z]/i.test(src[i])) i++; // flags
				return i;
			}
			i++;
		}
		return start;
	};

	/** `i` is just after the opening backtick; returns the index after the closing one. */
	const scanTemplate = (i: number): number => {
		let start = i;
		while (i < n) {
			const c = src[i];
			if (c === "\\") {
				i += 2;
				continue;
			}
			if (c === "`") {
				blank(bare, start, i);
				return i + 1;
			}
			if (c === "$" && src[i + 1] === "{") {
				blank(bare, start, i);
				i = scanCode(i + 2, true);
				start = i;
				continue;
			}
			i++;
		}
		blank(bare, start, n);
		return n;
	};

	/** Scans code; with `inTemplate` it returns at the `}` closing a `${`. */
	const scanCode = (i: number, inTemplate: boolean): number => {
		let depth = 0;
		while (i < n) {
			const c = src[i];
			const d = src[i + 1];
			if (c === "/" && d === "/") {
				const end = src.indexOf("\n", i);
				const stop = end < 0 ? n : end;
				blankBoth(i, stop);
				i = stop;
				continue;
			}
			if (c === "/" && d === "*") {
				const end = src.indexOf("*/", i + 2);
				const stop = end < 0 ? n : end + 2;
				blankBoth(i, stop);
				i = stop;
				continue;
			}
			if (c === '"' || c === "'") {
				let j = i + 1;
				while (j < n && src[j] !== c && src[j] !== "\n") {
					if (src[j] === "\\") j++;
					j++;
				}
				blank(bare, i + 1, j);
				i = j + 1;
				continue;
			}
			if (c === "`") {
				i = scanTemplate(i + 1);
				continue;
			}
			if (c === "/" && regexAllowed(i)) {
				i = scanRegex(i + 1);
				continue;
			}
			if (inTemplate) {
				if (c === "{") depth++;
				else if (c === "}") {
					if (depth === 0) return i + 1;
					depth--;
				}
			}
			i++;
		}
		return n;
	};

	scanCode(0, false);
	return { code: code.join(""), bare: bare.join("") };
}

/** 1-based line of `index` in `text`. */
function lineOf(text: string, index: number): number {
	let line = 1;
	for (let k = 0; k < index && k < text.length; k++) if (text[k] === "\n") line++;
	return line;
}

/** Every `file:line: <match>` of `re` in `text` (`re` must be global). */
function findAll(file: string, text: string, re: RegExp): string[] {
	const hits: string[] = [];
	for (const m of text.matchAll(re)) {
		hits.push(`${file}:${lineOf(text, m.index)}: ${m[0].trim()}`);
	}
	return hits;
}

/** Import/export specifiers of `code`: `from "x"`, `import "x"`, `import("x")`. */
function specifiers(code: string): { spec: string; index: number }[] {
	const out: { spec: string; index: number }[] = [];
	for (const m of code.matchAll(/\b(?:from|import)\s*\(?\s*["']([^"'\n]+)["']/g)) {
		out.push({ spec: m[1], index: m.index });
	}
	return out;
}

interface SourceFile {
	/** Repo-relative, `/`-separated (e.g. `src/adapters/deno.ts`) */
	rel: string;
	scanned: Scanned;
}

function loadSources(): SourceFile[] {
	return walk(SRC).map((abs) => ({
		rel: relative(ROOT, abs).split(sep).join("/"),
		scanned: scan(readFileSync(abs, "utf8")),
	}));
}

const sources = loadSources();

// ---------------------------------------------------------------------------
// the guard
// ---------------------------------------------------------------------------

test("portability guard: scans src/ (sanity)", () => {
	const rels = sources.map((s) => s.rel);
	assert.ok(
		rels.includes("src/demino.ts"),
		`src/demino.ts not found in ${rels.join(", ")}`,
	);
	assert.ok(rels.includes("src/adapters/deno.ts"), "src/adapters/deno.ts not found");
	assert.ok(rels.length > 20, `expected a real tree, found ${rels.length} files`);
});

test("portability guard: scanner strips comments, keeps/blanks literals, survives regexes", () => {
	const src = [
		"const a = `${route}/*`; // trailing Deno.cwd()",
		'const b = "http://x//y"; /* Deno.cwd() */ const c = Deno.cwd();',
		"const d = /\"[/*]'/g.test(x) ? w / 2 : z / 3;",
		"const e = `outer ${`inner ${1 + 1}`} Bun.x`;",
		'import { z } from "jsr:@scope/pkg";',
	].join("\n");
	const { code, bare } = scan(src);

	// comments gone from both views, line structure intact
	assert.equal(code.split("\n").length, 5);
	assert.equal(bare.split("\n").length, 5);
	assert.ok(!/trailing|cwd\(\) \*\//.test(code), "comments must be blanked in `code`");
	// the template literal holding `/*` must not swallow the rest of the file
	assert.match(code, /const c = Deno\.cwd\(\);/);
	assert.match(bare, /const c = Deno\.cwd\(\);/);
	// regex literal with quotes and `/*` inside: following code still visible
	assert.match(bare, /\? w \/ 2 : z \/ 3;/);
	// literal bodies are blanked in `bare` only
	assert.ok(!/Bun\.x/.test(bare), "template bodies must be blanked in `bare`");
	assert.match(code, /Bun\.x/);
	assert.ok(!/http:\/\/x/.test(bare), "string bodies must be blanked in `bare`");
	assert.deepEqual(
		specifiers(code).map((s) => s.spec),
		["jsr:@scope/pkg"],
	);
	// the `//` inside the string on line 2 must not be taken for a comment
	assert.match(code, /const b = "http:\/\/x\/\/y";/);
});

test("portability guard (a): no Deno/Bun globals outside src/adapters/", () => {
	const onBare = [
		/\bDeno\./g,
		/\bBun\./g,
		/\btypeof\s+(Deno|Bun)\b/g,
		/\bglobalThis\.(Deno|Bun)\b/g,
	];
	// runtime detection through a string key is a coupling too
	const onCode = [
		/["'](Deno|Bun)["']\s+in\s+globalThis\b/g,
		/\bglobalThis\s*\[\s*["'](Deno|Bun)["']\s*\]/g,
	];
	const violations: string[] = [];
	for (const { rel, scanned } of sources) {
		if (rel.startsWith("src/adapters/")) continue;
		for (const re of onBare) violations.push(...findAll(rel, scanned.bare, re));
		for (const re of onCode) violations.push(...findAll(rel, scanned.code, re));
	}
	assert.deepEqual(
		violations,
		[],
		"runtime globals outside src/adapters/:\n" + violations.join("\n"),
	);
});

test("portability guard (b): each runtime global is named by its own adapter only", () => {
	const violations: string[] = [];
	for (const [name, owner] of Object.entries(RUNTIME_OWNER)) {
		const re = new RegExp(`\\b${name}\\b`, "g");
		for (const { rel, scanned } of sources) {
			if (rel === owner) continue;
			violations.push(...findAll(rel, scanned.bare, re));
		}
	}
	assert.deepEqual(
		violations,
		[],
		"runtime names outside their adapter:\n" + violations.join("\n"),
	);
});

test("portability guard (c): no @std/, jsr:, npm: or https: imports in src/", () => {
	const violations: string[] = [];
	let total = 0;
	for (const { rel, scanned } of sources) {
		for (const { spec, index } of specifiers(scanned.code)) {
			total++;
			if (FORBIDDEN_SPECIFIER.test(spec)) {
				violations.push(`${rel}:${lineOf(scanned.code, index)}: ${spec}`);
			}
		}
	}
	assert.ok(total > 0, "no import specifiers found at all - scanner broken?");
	assert.deepEqual(
		violations,
		[],
		"non-portable import specifiers:\n" + violations.join("\n"),
	);
});

test("portability guard (d): erasable-only syntax (no enum, namespace, parameter properties)", () => {
	const patterns = [
		/^[ \t]*(export\s+)?(declare\s+)?(const\s+)?enum\s/gm,
		/^[ \t]*(export\s+)?(declare\s+)?namespace\s/gm,
		/\bconstructor\s*\(\s*(private|public|protected|readonly)\b/g,
	];
	const violations: string[] = [];
	for (const { rel, scanned } of sources) {
		for (const re of patterns) violations.push(...findAll(rel, scanned.bare, re));
	}
	assert.deepEqual(
		violations,
		[],
		"non-erasable TypeScript syntax:\n" + violations.join("\n"),
	);
});
