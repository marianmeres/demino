# Code Conventions

## File Organisation

```
src/
├── mod.ts              # Main barrel export (core + middleware + misc + router + static + utils)
├── demino.ts           # Core implementation (+ DeminoServeInfo / DeminoServeHandler types)
├── deno.ts             # Flat shim: `@marianmeres/demino/deno`  → adapters/deno.ts
├── node.ts             # Flat shim: `@marianmeres/demino/node`  → adapters/node.ts
├── middleware.ts       # Flat shim: `@marianmeres/demino/middleware` → middleware/mod.ts
├── misc.ts / router.ts / utils.ts   # Flat shims for the other barrels
├── adapters/
│   ├── types.ts        # ServeOptions / ServeHandle / ServeFn (the contract; no runtime code)
│   └── {deno,node}.ts  # One serve() per runtime — the ONLY files that may touch a runtime global
├── static/
│   ├── mod.ts          # Static barrel export
│   ├── serve-static.ts # serveStatic() + DeminoStaticOptions
│   └── mime.ts         # Content-type lookup (mrmime)
├── router/
│   ├── mod.ts          # Router barrel export
│   └── *.ts            # Router implementations
├── middleware/
│   ├── mod.ts          # Middleware barrel export
│   └── *.ts            # Middleware factories
├── misc/
│   ├── mod.ts          # Misc barrel export
│   └── *.ts            # Additional features
└── utils/
    ├── mod.ts          # Utils barrel export
    └── *.ts            # Utility functions
```

**Rules**:

- Each directory has a `mod.ts` barrel that re-exports all public symbols
- Implementation files are siblings to `mod.ts`
- Every public subpath is a flat shim `src/<name>.ts`: `deno.json` `exports` (JSR) maps `./x`
  to it, `package.json` `exports` (npm) to its `tsc` output `dist/x.js` + `dist/x.d.ts`, and
  `tests/manifest-sync.test.ts` (`EXPORTS`) checks both maps
- Test files go in `tests/` directory, mirroring `src/` structure

## Portability

`src/` runs unchanged on Deno and Node. The rule, enforced by
`tests/portability.test.ts` on both runtimes:

✅ Do:

- web standards (`Request`, `Response`, `Headers`, `URL`, `ReadableStream`, `WebSocket`,
  `AbortSignal`)
- the `node:*` subset where web standards do not reach: `node:fs`, `node:path`, `node:url`,
  `node:os`, `node:net`, `node:stream`, `node:http` (adapter only)
- read `process.env` / `process.stdout.isTTY` defensively (every supported runtime exposes the
  shape; see `src/utils/ansi.ts`, `src/utils/log-listen-info.ts`)
- in an adapter, type the slice of `Deno` you use locally, so the file checks under a plain
  `tsc` run without ambient runtime types
- `import type` for types (`verbatimModuleSyntax`)

❌ Don't:

- `Deno.*`, `typeof Deno`, `globalThis.Deno`, `"Deno" in globalThis` anywhere outside
  `src/adapters/`; the word `Deno` belongs to `src/adapters/deno.ts` only (comments and
  strings aside)
- the word `Bun` anywhere in `src/` code: Bun is not a supported runtime (plain HTTP works
  under `Bun.serve({ fetch: app })`, untested), so nothing may couple to it
- `@std/`, `jsr:`, `npm:` or `https:` import specifiers in `src/` — bare specifiers only, so the
  same source resolves through `deno.json` `imports` and `package.json`
- non-erasable TypeScript: `enum`, `namespace`, constructor parameter properties (Node strips
  types, it never lowers them)
- a new dependency in only one manifest — `deno.json` `imports` and `package.json` must carry
  the same range (`tests/manifest-sync.test.ts`); `package.json` is also the published npm
  manifest

## Naming Conventions

| Item                 | Convention                       | Example                               |
| -------------------- | -------------------------------- | ------------------------------------- |
| Types/Interfaces     | `Demino` prefix + PascalCase     | `DeminoContext`, `DeminoHandler`      |
| Adapter contract     | bare PascalCase / `serve`        | `ServeOptions`, `ServeHandle`, `serve` |
| Factory functions    | camelCase, often `demino` prefix | `demino()`, `deminoCompose()`         |
| Middleware factories | camelCase, descriptive           | `cors()`, `rateLimit()`, `proxy()`    |
| Utility functions    | camelCase                        | `parseCookies()`, `serializeCookie()` |
| Constants            | UPPER_SNAKE_CASE                 | `HTTP_STATUS` (from http-utils)       |

## Patterns

### Middleware Factory Pattern

Middleware is created via factory functions that return `DeminoHandler`:

```ts
// Do: Factory with options
export function myMiddleware(options: MyOptions = {}): DeminoHandler {
  return (req, info, ctx) => {
    // Implementation
  };
}

// Don't: Direct handler export
export const myMiddleware: DeminoHandler = (req, info, ctx) => { ... };
```

### Handler Signature

All handlers use the same signature:

```ts
((req: Request, info: DeminoServeInfo, ctx: DeminoContext) => any);
```

`info` is what the runtime adapter passed to the app: `remoteAddr?`, `upgradeWebSocket?`,
`raw?` — every field optional, so read it as `info.remoteAddr?.hostname`. The app itself is a
`DeminoServeHandler`: `(req: Request, info?: DeminoServeInfo) => Promise<Response>`.

### Response Returns

```ts
// Do: Return data directly
app.get("/users", () => users);              // → JSON
app.get("/", () => "Hello");                  // → text/html
app.get("/empty", () => undefined);           // → 204 No Content
app.get("/custom", () => new Response(...));  // → pass-through

// Don't: Manually stringify JSON
app.get("/users", () => JSON.stringify(users));
```

### Runtime Capabilities

Anything the runtime may or may not provide is an optional field on `info`, checked at the
call site — never a runtime sniff:

```ts
// Do: feature-detect through info
if (info.upgradeWebSocket) { ... } else { /* fall back, warn once */ }

// Don't: sniff the runtime
if ("Deno" in globalThis) { ... }
```

## Anti-Patterns

| Anti-Pattern                          | Problem                                | Solution                                  |
| ------------------------------------- | -------------------------------------- | ----------------------------------------- |
| Returning `undefined` unintentionally | Creates 204 response                   | Return explicit value or Response         |
| Mutating `ctx.params`                 | Params are frozen                      | Use `ctx.locals` for derived data         |
| Forgetting to await async middleware  | Next middleware runs before completion | Always await async operations             |
| Reassigning `app.locals`              | Assignment is ignored                  | Mutate properties: `app.locals.foo = bar` |
| Runtime global in core                | Breaks the other two runtimes          | Put it behind `info` or in an adapter     |
| `@std/*` import in `src/`             | Deno-only resolution                   | `node:*` built-in or inline the helper    |

## Error Handling

Use `@marianmeres/http-utils` for HTTP errors:

```ts
import { createHttpError, HTTP_ERROR } from "@marianmeres/http-utils";

// Do: Throw typed HTTP errors
throw createHttpError(404);
throw createHttpError(401, "Invalid token");
throw new HTTP_ERROR.NotFound();
throw new HTTP_ERROR.Unauthorized("Invalid token");

// Don't: Throw generic errors for HTTP responses
throw new Error("Not found"); // Results in 500, not 404
```

Filesystem "not found" is reported portably: a plain `Error` with `code: "ENOENT"` (and
`name: "NotFound"` from `deminoFileBased`). Match on `code`, never on a runtime error class.

## Testing Standards

- **Location**: `tests/` directory
- **Naming**: `*.test.ts`
- **Framework**: `node:test` + `node:assert/strict` — one suite, two runners:
  `pnpm test` (Node), `pnpm run test:deno`
- **Servers**: never start one by hand — `startTestServer(handler)` /
  `runTestServerTests([...])` from `tests/_utils.ts` go through the adapter of the current
  runtime (the only runtime-specific code in the suite) on a free port, silently
- **Runtime-specific cases**: `{ skip: !isDeno }` with `isDeno` / `isNode` from
  `tests/_utils.ts`, and a comment stating the reason — only for differences by design (e.g.
  the Deno adapter tests need `Deno`)
- **Types**: `pnpm run typecheck` (`tsc --noEmit`, `src/` + `tests/`) is the only type gate —
  Node strips types without checking
- **Format / lint**: Biome — `pnpm run format` before committing, `pnpm run lint` is gated.
  Tabs, 4 wide, 90 columns, double quotes; manifests 2 spaces. The recommended rules the code
  base broke at adoption (2026-10-29) are set to `warn` in `biome.json`: fixing them changes
  code, so each is its own change — fix a rule's findings, then delete its line

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { demino } from "../src/mod.ts";
import { runTestServerTests } from "./_utils.ts";

// in-process: call the app directly, no server
test("description", async () => {
	const app = demino();
	app.logger(null);
	app.get("/", () => "ok");

	const res = await app(new Request("http://localhost/"));
	assert.equal(res.status, 200);
});

// through the runtime adapter: a real server on a free port
runTestServerTests([
	{
		name: "GET / over the wire",
		async fn({ app, get }) {
			app.get("/", () => "ok");
			const res = await get("/");
			assert.equal(res.status, 200);
		},
	},
]);
```

Run tests:

```bash
pnpm test             # Node (after `pnpm install`)
pnpm run test:deno    # Deno
pnpm run typecheck    # tsc --noEmit
```

Guard tests worth knowing: `tests/portability.test.ts` (the rule above),
`tests/manifest-sync.test.ts` (`deno.json` ↔ `package.json` ↔ exports map),
`tests/types/deno-serve-compat.test.ts` (the app stays a drop-in Deno serve handler).
