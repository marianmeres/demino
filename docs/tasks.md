# Common Tasks

## Running on Each Runtime

### Steps

1. Import `serve` from the adapter subpath of the runtime you are on (Deno or Node; Bun is not
   supported - plain HTTP works under `Bun.serve({ fetch: app })`, untested)
2. Pass the app (or a `deminoCompose()` result); `await` the `ServeHandle`

### Template

```ts
import { demino } from "@marianmeres/demino";
import { serve } from "@marianmeres/demino/deno"; // Deno
// import { serve } from "@marianmeres/demino/node"; // Node  (npm i ws for WebSockets)

const app = demino();
app.get("/", () => "Hello");

const server = await serve(app, { port: 8000 }); // defaults: 0.0.0.0:8000, logListenInfo
// server.url, server.port, await server.shutdown()
```

### Checklist

- [ ] Same code on every runtime except the adapter import line
- [ ] Node: `ws` installed if `info.upgradeWebSocket` (WebSocket tunneling) is needed
- [ ] No `Deno.*` in app code that must run elsewhere — read `info` instead

---

## Verifying a Change

Run, in this order, before committing (CI runs the same):

```bash
pnpm run format          # Biome (formatting + safe fixes)
pnpm run ci              # typecheck, lint, Node suite, npm smoke (needs `pnpm install` once)
pnpm run test:deno       # Deno suite
pnpm run jsr:check       # JSR package shape (slow types, exports map); needs a clean tree
```

---

## Adding a New Middleware

### Steps

1. Create file in `src/middleware/[name].ts`
2. Export factory function returning `DeminoHandler`
3. Add export to `src/middleware/mod.ts`
4. Add tests in `tests/middleware/[name].test.ts`

### Template

```ts
// src/middleware/my-middleware.ts
import type { DeminoHandler } from "../demino.ts";

export interface MyMiddlewareOptions {
	// Options here
}

export function myMiddleware(options: MyMiddlewareOptions = {}): DeminoHandler {
	return (req, info, ctx) => {
		// Implementation
		// Return undefined to continue chain
		// Return value to stop chain and respond
	};
}
```

### Checklist

- [ ] Factory function exported (not direct handler)
- [ ] Options interface exported
- [ ] Added to `src/middleware/mod.ts`
- [ ] Portable: no runtime global, no `@std/` import (`tests/portability.test.ts` fails otherwise)
- [ ] Tests pass on both runtimes: `pnpm test`, `pnpm run test:deno`

---

## Adding a New Router

### Steps

1. Create file in `src/router/[name]-router.ts`
2. Extend `DeminoRouter` abstract class
3. Implement `on()` and `exec()` methods
4. Add export to `src/router/mod.ts`
5. Add tests in `tests/router/[name]-router.test.ts`

### Template

```ts
// src/router/my-router.ts
import { DeminoRouter, type DeminoRouterExecResult } from "./abstract.ts";

export class MyRouter extends DeminoRouter {
	on(route: string): void {
		// Register route pattern
	}

	exec(pathname: string): DeminoRouterExecResult | undefined {
		// Match pathname against registered routes
		// Return { route, params } or undefined
	}
}
```

### Usage

```ts
const app = demino("", [], { routerFactory: () => new MyRouter() });
```

### Checklist

- [ ] Extends `DeminoRouter`
- [ ] Implements `on()` and `exec()`
- [ ] Added to `src/router/mod.ts`
- [ ] Tests pass

---

## Adding a New Utility

### Steps

1. Create file in `src/utils/[name].ts`
2. Export function(s)
3. Add export to `src/utils/mod.ts`
4. Add tests if non-trivial

### Template

```ts
// src/utils/my-util.ts
export function myUtil(input: string): string {
	// Implementation
}
```

### Checklist

- [ ] Added to `src/utils/mod.ts`
- [ ] Tests pass (if applicable)

---

## Adding a Runtime Adapter

### Steps

1. Create `src/adapters/[name].ts` exporting `serve: ServeFn` (from `./types.ts`). Type the
   slice of the runtime global you use locally (see `deno.ts`) so `tsc` checks the file
   without ambient runtime types
2. Per request fill a `DeminoServeInfo`: `remoteAddr` (read at request start — peers vanish
   once the connection closes), `upgradeWebSocket` (Deno-shaped: `{ socket, response }`,
   socket CONNECTING until the handler returned the 101, then `open`), `raw`
3. Honour the contract: defaults `0.0.0.0:8000`, `onListen` defaults to `logListenInfo`,
   `signal` abort = forceful close of listener + every connection, `shutdown()` graceful with a
   5 s force, `ServeHandle.url` via `toUrl()`, `port: 0` reports the real port, port-in-use
   rejects with `code: "EADDRINUSE"`
4. Add the flat shim `src/[name].ts` (re-export `serve` + the three types, like `src/deno.ts`)
5. Add `"./[name]": "./src/[name].ts"` to `deno.json` `exports`, its `dist/` twin
   (`{ "types": "./dist/[name].d.ts", "import": "./dist/[name].js" }`) to `package.json`
   `exports`, and the entry to `EXPORTS` in `tests/manifest-sync.test.ts`
6. If the adapter names a new runtime global, add it to `RUNTIME_OWNER` in
   `tests/portability.test.ts`
7. Teach `pickServe()` in `tests/_utils.ts` to select it, add `tests/adapters/[name].test.ts`,
   add the runtime to `.github/workflows/ci.yml`

### Checklist

- [ ] Only this file says the runtime's name (portability guard b)
- [ ] `tests/adapters/[name].test.ts` covers: defaults, `port: 0`, `url`, `remoteAddr` →
  `ctx.ip`, a WebSocket echo, `signal` vs `shutdown()`, port in use
- [ ] Full suite green on that runtime through the harness

---

## Adding a Dependency

### Steps

1. Add it to `deno.json` `imports` (`npm:`/`jsr:` specifier) **and** `package.json`
   `dependencies` with the same `^x.y.z` range — `tests/manifest-sync.test.ts` fails otherwise
2. Import it by its bare name from `src/`; confirm it runs on Deno and Node
3. `pnpm install` to refresh `pnpm-lock.yaml` (`package.json` is also the published manifest -
   nothing else lists the dependency)

### Checklist

- [ ] No `@std/*` (Deno-only resolution) — use a `node:*` built-in or inline the helper
- [ ] Zero runtime-specific code inside the dependency
- [ ] `pnpm run smoke` still succeeds

---

## Serving Static Files

### Steps

1. `app.static(route, fsRoot, options?)` for the common case
2. `serveStatic(req, { fsRoot, urlRoot, ...options })` directly when you need your own route
   or per-request headers

### Template

```ts
import { demino, serveStatic } from "@marianmeres/demino";

const app = demino();

// mounted on GET/HEAD /files/*
app.static("/files", "./public", {
	showIndex: true, // index.html for a directory (default)
	showDotfiles: false, // /.env → 404 (default)
	etag: true, // ETag/Last-Modified + 304 (default)
	headers: (req, filePath) => ({ "cache-control": "no-cache" }),
});

// or under your own route
app.get("/assets/*", (req) =>
	serveStatic(req, {
		fsRoot: "./public/assets",
		urlRoot: "assets",
		headers: { "cache-control": "public, max-age=31536000, immutable" },
	}),
);
```

### Checklist

- [ ] `route` has no dynamic segments (`[x]`, `:x`)
- [ ] CORS, if needed, via `headers: { "access-control-allow-origin": … }` — `cors()` does not
  reach a handler-returned `Response`
- [ ] Non-"not found" fs errors reach the app's error handler (they are thrown)

---

## Creating File-Based Routes

### Steps

1. Create directory structure under your routes folder
2. Add `index.ts` with HTTP method exports
3. Add `_middleware.ts` for route-specific middleware

### Directory Structure

```
routes/
├── _middleware.ts          # Global middleware (optional)
├── index.ts                # GET / handler
└── users/
    ├── _middleware.ts      # /users middleware (optional)
    ├── index.ts            # GET /users handler
    └── [userId]/
        ├── _middleware.ts  # /users/[userId] middleware
        └── index.ts        # GET /users/[userId] handler
```

### Route File Template

```ts
// routes/users/index.ts
import type { DeminoHandler } from "@marianmeres/demino";

export const GET: DeminoHandler = (req, info, ctx) => {
	return { users: [] };
};

export const POST: DeminoHandler = async (req, info, ctx) => {
	const body = await req.json();
	return { created: true };
};
```

### Middleware File Template

```ts
// routes/users/_middleware.ts
import type { DeminoHandler } from "@marianmeres/demino";

const authMiddleware: DeminoHandler = (req, info, ctx) => {
	// Validation logic
};

export default [authMiddleware];
```

### Setup

```ts
import { demino, deminoFileBased } from "@marianmeres/demino";
import { serve } from "@marianmeres/demino/deno"; // or "/node"

const app = demino();
await deminoFileBased(app, "./routes");
await serve(app);
```

### Checklist

- [ ] `index.ts` exports HTTP method handlers (GET, POST, etc.)
- [ ] `_middleware.ts` default exports array of middlewares
- [ ] No directories starting with `_` or `.` (except `_middleware.ts`)
- [ ] Using default router (file-based routing requires DeminoSimpleRouter)
- [ ] Root dir exists — a missing root throws a plain `Error` with `code: "ENOENT"` and
  `name: "NotFound"` by default (match on `code`); pass `ignoreMissingRootDir: true` only
  for genuinely optional dirs

---

## Composing Multiple Apps

### Steps

1. Create separate Demino apps with different mount paths
2. Use `deminoCompose()` to combine them

### Template

```ts
import { demino, deminoCompose } from "@marianmeres/demino";
import { serve } from "@marianmeres/demino/deno"; // or "/node"

const app = demino(); // Root routes
const api = demino("/api"); // API routes
const admin = demino("/admin"); // Admin routes

// Each app has isolated middleware
api.use(authMiddleware);
admin.use(adminOnlyMiddleware);

// Compose and serve (the result is a DeminoServeHandler like the apps themselves)
await serve(deminoCompose([app, api, admin]));
```

### Checklist

- [ ] Each app has unique mount path
- [ ] Mount paths don't overlap
- [ ] Order in array doesn't matter (routing is by mount path)
