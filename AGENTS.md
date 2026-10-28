# AGENTS.md - Demino Package Knowledge Base

Machine-friendly documentation for AI agents working with @marianmeres/demino.

## Package Identity

- **Name**: @marianmeres/demino
- **Registry**: JSR (jsr.io/@marianmeres/demino) + npm (dual-published via `@marianmeres/npmbuild`)
- **Version**: 2.0.0 (this branch; `deno.json` keeps the last 1.x number until the release task bumps it)
- **Runtime**: web standards + the `node:*` subset — Deno and Node (≥ 22) through runtime adapters;
  Bun is not supported (plain HTTP works under `Bun.serve({ fetch: app })`, untested)
- **Type**: Web server framework
- **Entry Points**: `src/mod.ts` (core, `.`); adapters `src/deno.ts` (`./deno`), `src/node.ts`
  (`./node`); barrels `./middleware`, `./misc`, `./router`, `./utils`

## Core Concept

Demino is a minimal web framework on web standards: an app is a
`(req: Request, info?: DeminoServeInfo) => Promise<Response>` function with routing, middleware,
error handling, static files and logging layered on top. The core touches no runtime global; a
small **runtime adapter** per runtime owns the HTTP server (`serve(app)`) and fills in `info`.

**Key Philosophy**: "Batteries NOT included" - provides building blocks, not a
full-featured server. "One signature everywhere" - the app code is identical on every runtime,
only the adapter import differs.

## Architecture Overview

```
serve(app)         <- @marianmeres/demino/deno | /node  (ServeFn: owns the server,
  |                   fills DeminoServeInfo {remoteAddr, upgradeWebSocket, raw}, returns ServeHandle)
  v
demino()           -> Demino app (a DeminoServeHandler; also a drop-in Deno serve handler)
  |
  ├── Router       -> Route matching (DeminoSimpleRouter default)
  ├── Middleware   -> Chain of DeminoHandler functions
  ├── Context      -> Request-scoped DeminoContext
  ├── Static       -> serveStatic() on node:fs (app.static)
  └── Response     -> Auto-generated from handler returns
```

## File Structure

```
src/
├── mod.ts                    # Main exports barrel (core + adapter types + middleware/misc/router/static/utils)
├── demino.ts                 # Core: demino(), Demino, DeminoContext, DeminoServeInfo, types
├── deno.ts                   # Flat shim -> adapters/deno.ts   (exports["./deno"])
├── node.ts                   # Flat shim -> adapters/node.ts   (exports["./node"])
├── middleware.ts             # Flat shim -> middleware/mod.ts  (exports["./middleware"])
├── misc.ts                   # Flat shim -> misc/mod.ts        (exports["./misc"])
├── router.ts                 # Flat shim -> router/mod.ts      (exports["./router"])
├── utils.ts                  # Flat shim -> utils/mod.ts       (exports["./utils"])
├── adapters/
│   ├── types.ts              # ServeOptions, ServeHandle, ServeFn (+ internal toUrl); no runtime code
│   ├── deno.ts               # serve() over Deno's built-in server (the only file that may say `Deno`)
│   └── node.ts               # serve() over node:http - own bridge; optional `ws` for upgrades
├── static/
│   ├── mod.ts                # Static exports barrel
│   ├── serve-static.ts       # serveStatic(), DeminoStaticOptions, ServeStaticOptions, DeminoStaticHeaders
│   └── mime.ts               # contentTypeFor() via mrmime (internal)
├── router/
│   ├── mod.ts                # Router exports barrel
│   ├── abstract.ts           # DeminoRouter base class
│   ├── simple-router.ts      # Default router (bracket params)
│   ├── urlpattern-router.ts  # URL Pattern API router
│   ├── fixed-router.ts       # Exact string matching
│   ├── regex-router.ts       # Regex-based routing
│   └── express-like-router.ts # Express-style router (deprecated)
├── middleware/
│   ├── mod.ts                # Middleware exports barrel
│   ├── authz.ts              # Policy-free authorization gate
│   ├── body-limit.ts         # Request body size limit (413/411 gate)
│   ├── cors.ts               # CORS headers
│   ├── cookies.ts            # Cookie parsing/setting
│   ├── rate-limit.ts         # Token bucket rate limiting
│   ├── etag.ts               # ETag/304 responses
│   ├── redirect.ts           # URL redirects
│   ├── trailing-slash.ts     # Slash normalization
│   └── proxy/
│       ├── proxy.ts          # Request proxying
│       ├── utils.ts          # Proxy utility functions
│       └── websocket.ts      # WebSocket tunnel (internal, not exported)
├── misc/
│   ├── mod.ts                # Misc exports barrel
│   ├── compose.ts            # deminoCompose() multi-app
│   └── file-based.ts         # Directory-based routing (node:fs)
└── utils/
    ├── mod.ts                # Utils exports barrel
    ├── ansi.ts               # green()/red() ANSI helpers, NO_COLOR aware (no dependency)
    ├── client-ip.ts          # getClientIpFromHeaders() - forwarding-header precedence
    ├── create-demino-clog.ts # DeminoLogger factory using @marianmeres/clog
    ├── log-listen-info.ts    # logListenInfo()/createLogListenInfo(), DeminoListenAddr (node:os)
    ├── token-bucket.ts       # TokenBucket class
    ├── cookies.ts            # parseCookies, serializeCookie
    ├── sleep.ts              # Promise delay
    ├── with-timeout.ts       # Timeout wrapper
    ├── is-fn.ts              # Function type guard
    ├── is-plain-object.ts    # Plain object type guard
    └── is-valid-date.ts      # Date type guard

tests/                        # node:test suite - runs under deno test and node --test
├── _utils.ts                 # Harness: startTestServer()/runTestServerTests() via the current runtime's adapter; isDeno/isNode
├── demino.test.ts            # Core framework tests
├── portability.test.ts       # Guard: no runtime globals / @std / non-erasable TS in src/
├── manifest-sync.test.ts     # Guard: deno.json <-> package.json <-> exports map
├── adapters/                 # One test file per adapter (deno/node)
├── middleware/               # Middleware tests
├── router/                   # Router tests
├── misc/                     # compose, file-based, static
├── types/                    # deno-serve-compat: the app stays a drop-in Deno serve handler
├── utils/                    # ansi, client-ip, log-listen-info, token-bucket, with-timeout
├── fixtures/                 # File-based routing fixtures
└── static/                   # Static file serving test files

scripts/
├── build-npm.ts              # npm package into .npm-dist/ (entry points derived from deno.json exports)
└── smoke-npm.mjs             # Installs .npm-dist into a temp project and imports every subpath (Node)
```

## Critical Types

### DeminoHandler

```ts
type DeminoHandler = (
	req: Request,
	info: DeminoServeInfo,
	ctx: DeminoContext,
) => any | Promise<any>;
```

### DeminoServeInfo (what the adapter passes as `info`)

```ts
interface DeminoServeInfo {
	remoteAddr?: DeminoRemoteAddr; // { hostname, port, transport? } - socket peer; feeds ctx.ip
	upgradeWebSocket?: DeminoUpgradeWebSocket; // (req, { protocol? }) => { socket, response }
	raw?: unknown; // runtime's own per-request object (Deno info / IncomingMessage)
}
type DeminoServeHandler = (req: Request, info?: DeminoServeInfo) => Response | Promise<Response>;
```

Every field optional: a missing `info` is normalised to a frozen `{}`, so always write
`info.remoteAddr?.hostname`. Capabilities are feature-detected through `info` (never by
sniffing the runtime). `upgradeWebSocket` is CONNECTING until the handler returned the 101,
then `open` — the same contract on both runtimes (Node holds early frames).

### Adapter contract (`src/adapters/types.ts`)

```ts
type ServeFn = (handler: DeminoServeHandler, options?: ServeOptions) => Promise<ServeHandle>;
interface ServeOptions {
	port?: number; // 8000; 0 = free port
	hostname?: string; // "0.0.0.0"
	signal?: AbortSignal; // abort = forceful close (listener + every connection)
	onListen?: (addr: DeminoListenAddr) => void; // default logListenInfo
	onError?: (error: unknown) => Response | Promise<Response>; // adapter failures only
	webSockets?: boolean; // Node only: lazily import `ws`; default true
}
interface ServeHandle {
	readonly hostname: string; readonly port: number; readonly url: string;
	readonly finished: Promise<void>;
	shutdown(): Promise<void>; // graceful; Node forces after 5 s
	ref(): void; unref(): void;
}
```

### DeminoContext

```ts
interface DeminoContext {
	url: URL; // Effective request URL, proxy-aware (since 1.15.0). readonly
	params: Record<string, string>; // Route params (frozen)
	locals: Record<string, any>; // Request-scoped storage
	routeMeta: Readonly<Record<string, unknown>>; // Static handler meta, frozen (since 1.10.0)
	headers: Headers; // Response headers
	status: number; // Response status
	route: string; // Matched route pattern
	ip: string; // Client IP (info.remoteAddr, or forwarding headers when trustProxy is on)
	error: any; // Error ref (error handlers)
	appLocals: any; // App-wide persistent data
	getLogger(): DeminoLogger | null;
	__start: Date; // Request timestamp
}
```

`ctx.url` (since 1.15.0) is the effective request `URL`. Prefer it over
`new URL(req.url)` whenever you need the request scheme/host/origin (absolute
self-links, absolute redirects). By default it equals `new URL(req.url)`; with
[`trustProxy`](#trustproxy--proxy-aware-ctxurl-since-1150) it is rebuilt from the
proxy's `X-Forwarded-Proto`/`-Host`/`-Port`. Always defined. Routing is unaffected —
dispatch always uses `url.pathname`, which `trustProxy` never rewrites.

### Demino Interface

```ts
interface Demino {
  (req: Request, info?: DeminoServeInfo): Promise<Response>; // the app IS the serve handler
  get/post/put/patch/delete/head/options/connect/trace/all: DeminoRouteHandler;
  use(...args): Demino;              // Register middleware
  error(handler): Demino;            // Set error handler
  static(route, fsRoot, options?: DeminoStaticOptions): Demino;
  logger(logger): Demino;
  mountPath(): string;
  info(): { routes, globalAppMiddlewaresCount };
  routes(): DeminoRouteInfo[];       // Enumerate (method, route, meta) per registration
  getOptions(): DeminoOptions;
  locals: DeminoAppLocals;           // App-wide persistent data (ctx.appLocals)
}
```

`Demino` does not extend any runtime type; it is structurally a Deno serve handler, so passing
it to the runtime directly still compiles (tested in `tests/types/deno-serve-compat.test.ts`).

`routes()` returns `{ method, route, meta }[]` mirroring the dispatcher match-set (ALL
router, catch-alls, auto-HEAD). It is the read-side companion to `routeMeta` — intended
for build-time introspection/audits (permission coverage, OpenAPI, sitemap). `meta` is
`{}` for handlers without metadata (e.g. `app.static`).

## Response Conversion Rules

Handler return values are auto-converted to Response:

| Return Type        | Conversion                |
| ------------------ | ------------------------- |
| `undefined`        | 204 No Content            |
| `null`             | JSON `null`               |
| Plain object/array | JSON stringified          |
| `toJSON()` objects | JSON stringified          |
| `Response`         | Pass through              |
| `Error`            | Error response            |
| Other              | `toString()` as text/html |

## Router Parameter Syntax

### DeminoSimpleRouter (default)

```
/users/[userId]              -> params.userId
/posts/[postId]/comments/*   -> wildcard support
```

### DeminoUrlPatternRouter

```
/users/:id                   -> params.id
/files/*                     -> wildcard
```

### DeminoRegexRouter

```
^/(?<year>\\d{4})$           -> params.year
```

### Catch-all (`*`) precedence

A `*` catch-all resolves **globally last**, across both the method-specific router and the
`ALL` router. Effective order: method real routes → ALL real routes → method `*` → ALL
`*`. A catch-all never shadows a more specific route.

Since 1.8.8: dispatch does a real-routes-only pass first (router's
`exec(pathname, { skipCatchAll: true })`), and only fires a catch-all when nothing real
matched anywhere. Previously a method-specific catch-all (`app.get("*")`) shadowed
`app.all("/files/*")` and could fake a `405` for unmatched `HEAD`. `app.all("*")` was
always correct and is unchanged. Only `DeminoSimpleRouter` (the default) keeps a deferred
internal catch-all; the other built-in routers match `*` positionally and ignore
`skipCatchAll`.

## Middleware Execution

1. Global app middlewares (`app.use(mw)`)
2. Route-global middlewares (`app.use("/route", mw)`)
3. Route-method middlewares (`app.get("/route", mw, handler)`)
4. Final handler (last argument to route method)

**Termination**: First non-undefined return stops chain.

**Sort Order**: Use `__midwarePreExecuteSortOrder` property to control position
(ascending; lower runs first). The exported `DEMINO_SORT` constant publishes the reference
points Demino assigns: `PRE` (100, before normal middleware), `DEFAULT` (1000, normal
middleware), `HANDLER` (Infinity, final handler). Tag a middleware
`mw.__midwarePreExecuteSortOrder = DEMINO_SORT.PRE` to run it ahead of the normal chain
(e.g. an auth gate) without hardcoding a magic number.

**Duplicates**: Set `__midwareDuplicable = true` to allow multiple instances.

## Dependencies

### Runtime (same name + range in `deno.json` `imports` and `package.json`; `tests/manifest-sync.test.ts` enforces it)

- @marianmeres/http-utils - HTTP errors/status codes
- @marianmeres/midware - Middleware chaining
- @marianmeres/simple-router - Default router implementation
- @marianmeres/clog - `createDeminoClog()` logger
- mrmime - content types for static files

### Optional peer (npm; `devDependencies` in the repo)

- ws - WebSocket upgrades in the Node adapter (lazily imported; missing = HTTP only, one warning)

### Built-ins

`node:fs`, `node:path`, `node:url`, `node:os`, `node:net`, `node:stream`, `node:http`. **No
`@std/*` in `src/`** (the portability guard fails the suite otherwise); the client-IP header
precedence is inlined in `getClientIpFromHeaders()`.

### Dev / tooling

- typescript (`npm run typecheck`, `tsc --noEmit`), @types/node, @types/ws
- @marianmeres/npmbuild (`scripts/build-npm.ts`), @marianmeres/mcp-server/types (`mcp.ts`)

## Common Patterns

### Basic App

```ts
import { demino } from "@marianmeres/demino";
import { serve } from "@marianmeres/demino/deno"; // or "/node"

const app = demino();
app.get("/", () => "Hello");
await serve(app);
```

### With Mount Path

```ts
const api = demino("/api");
api.get("/users", getUsers); // handles /api/users
```

### Middleware Registration

```ts
app.use(globalMw); // All routes
app.use("/protected", authMw); // Specific route
app.get("/data", validateMw, handler); // Method-specific
```

### Custom Error Handler

```ts
app.error((req, info, ctx) => {
	return { error: ctx.error.message };
});
```

### Composition

```ts
const app = demino();
const api = demino("/api");
await serve(deminoCompose([app, api])); // deminoCompose() returns a DeminoServeHandler
```

### File-Based Routing

```ts
const app = demino();
await deminoFileBased(app, "./routes");
```

### WebSocket endpoint (through the adapter's capability)

```ts
app.get("/ws", (req, info) => {
	if (!info.upgradeWebSocket) throw createHttpError(501);
	const { socket, response } = info.upgradeWebSocket(req);
	socket.onmessage = (e) => socket.send(e.data);
	return response;
});
```

## Testing

One `node:test` + `node:assert/strict` suite, two runners:

```bash
deno task test            # Deno
npm test                  # Node (run `npm install` once on a fresh checkout)
npm run typecheck         # tsc --noEmit over src/ + tests/ (the only type gate)
deno task test:watch      # Deno watch mode
```

Test files located in: `tests/`. Server tests go through `startTestServer()` /
`runTestServerTests()` in `tests/_utils.ts`, which picks the adapter of the current runtime.
Runtime-only cases use `{ skip: !isDeno }` with a comment stating why.
Guards: `tests/portability.test.ts`, `tests/manifest-sync.test.ts`,
`tests/types/deno-serve-compat.test.ts`. CI (`.github/workflows/ci.yml`) runs Deno (pinned)
and Node 24 + 26.

## Tasks and Scripts

```bash
deno task dev             # Run main module with watch
deno task test            # Run all tests on Deno
npm test                  # Run all tests on Node
npm run typecheck         # tsc --noEmit
deno publish --dry-run    # JSR package check
deno task npm:build       # Build the npm package into .npm-dist/
deno task npm:smoke       # Build + install into a temp project + import every subpath (Node)
deno task release         # Bump version (release tooling)
deno task publish         # deno publish + npm publish of .npm-dist/
```

## Special Behaviors

1. **HEAD requests**: Auto-generated from GET handlers
2. **Trailing slashes**: `/foo` and `/foo/` are equivalent (use trailingSlash middleware
   to enforce)
3. **Error logging** (since 1.16.0): Only server faults (status `>= 500`) are logged via
   `logger.error()`, as a structured `{ status, method, url, ip, error }` object (logged
   once; `url`=proxy-aware `ctx.url.href`, `error`=stringified stack). Client errors
   (`4xx` incl. `404`, and a `*` catch-all that throws `404`) are NOT error-logged — read
   them from the access log. `logger(null)` silences all.
4. **Access logging**: Default logger forwards `access` to `console.log` (since 1.7.0).
   Set `logger: null` or override `access` to silence.
5. **Mount path validation**: Must start with `/`, cannot end with `/`, no dynamic
   segments
6. **Per-(method, route) middleware caching** (since 1.7.0): The assembled `Midware` for
   each route is built once on the first matching request and reused. The cache is
   invalidated when `app.use(...)` runs or when a route is (re-)registered.
7. **File-based missing root dir**: `deminoFileBased()` throws a plain `Error` with
   `name: "NotFound"` and `code: "ENOENT"` when a root directory is absent — fail-loud at
   boot, not a silently-empty app. Match on `code`. Pass `ignoreMissingRootDir: true` to skip
   absent roots with a `logger.warn`. A root that exists but is not a directory always throws
   `TypeError`.
8. **WebSocket tunneling needs an adapter**: `proxy()` upgrades the client leg through
   `info.upgradeWebSocket`. Without it (app handed to the runtime's own server, or the Node
   adapter with `webSockets: false` / no `ws`) upgrade requests are forwarded as plain HTTP
   and one warning is logged per process.
9. **`ctx.ip` without an adapter**: Deno's own server passes `remoteAddr`, so `ctx.ip` works.
   Bun is not supported: `Bun.serve({ fetch: app })` serves plain HTTP, but `ctx.ip` is `""`
   and there is no upgrade capability.
10. **Adapter defaults mirror Deno**: `0.0.0.0:8000`, `onListen` prints the listen info,
    `signal` abort is forceful, `shutdown()` graceful (Node forces after 5 s), port in use
    rejects with `code: "EADDRINUSE"`.

## Common Modifications

### Add New Middleware

1. Create file in `src/middleware/`
2. Export factory function returning `DeminoHandler`
3. Add export to `src/middleware/mod.ts`
4. Stay portable: no runtime global, no `@std/` import

### Add New Router

1. Extend `DeminoRouter` abstract class
2. Implement `on()` and `exec()` methods
3. Use via `routerFactory` option

### Add New Utility

1. Create file in `src/utils/`
2. Add export to `src/utils/mod.ts`

### Add a Runtime Adapter / a Dependency

See [docs/tasks.md](./docs/tasks.md#adding-a-runtime-adapter) — exports map, `EXPORTS` in
`tests/manifest-sync.test.ts`, `RUNTIME_OWNER` in `tests/portability.test.ts`, harness
`pickServe()`, CI matrix; dependencies go in both manifests plus `scripts/build-npm.ts`.

## Error Handling

```ts
// Throw HTTP errors
import { createHttpError, HTTP_ERROR } from "@marianmeres/http-utils";
throw createHttpError(404);
throw new HTTP_ERROR.NotFound();

// Custom handler
app.error((req, info, ctx) => {
	ctx.status = ctx.error?.status || 500;
	return { error: ctx.error.message };
});
```

## Static Files

```ts
app.static("/files", "/path/to/dir", options?); // mounts ALL /files/* -> serveStatic()
// options: DeminoStaticOptions { showIndex=true, showDotfiles=false, etag=true, headers?: HeadersInit | (req, filePath) => HeadersInit }

import { serveStatic } from "@marianmeres/demino"; // standalone, under your own route
app.get("/public/*", (req) => serveStatic(req, { fsRoot: "./public", urlRoot: "public" }));
```

`serveStatic()` (`src/static/serve-static.ts`, `node:fs`): GET/HEAD only (405 otherwise), 400
on bad percent-encoding, 301 (relative `Location`) to the normalised path / trailing-slash
form, 404 outside root / dot-segments / missing, weak `ETag` `W/"<size>-<mtime>"` +
`Last-Modified` + 304, single `Range` → 206/416, content types via `mrmime`
(`application/octet-stream` fallback, `; charset=utf-8` on text-like). Non-ENOENT fs errors
are thrown (reach the error handler). CORS is not a static option — `app.use(route, cors())`.

## Rate Limiting

```ts
app.use(
	"/api",
	rateLimit(
		(req, info, ctx) => req.headers.get("Authorization"),
		{ maxSize: 20, refillSizePerSecond: 10 },
	),
);
```

## Proxy

```ts
app.get(
	"/api/*",
	proxy("https://backend/*", {
		preventSSRF: true,
		timeout: 30000,
	}),
);
```

**SSRF check coverage** (`isPrivateHost`, since 1.7.0):

- localhost / `127.0.0.0/8`
- `0.0.0.0`, `::`
- Private IPv4: `10/8`, `100.64/10` (CGNAT), `169.254/16`, `172.16/12`, `192.168/16`
- Private IPv6: `::1`, `fe80::/10`, `fc00::/7`
- IPv4-mapped IPv6 (`::ffff:127.0.0.1`)
- Bracketed IPv6 hostnames (`[::1]`)

**Caveat:** string-only check, no DNS resolution. DNS rebinding bypasses this guard. For
DNS-rebinding-resistant SSRF protection, resolve via `node:dns` and re-check each result.

**WebSocket proxying** (since 1.17.0): well-formed upgrade requests are tunneled to the
upstream by default (`webSockets: false` disables; malformed upgrades fall through to the
HTTP path). Upstream is dialed FIRST (full target policy + forwarded headers incl.
cookies/auth/`X-Forwarded-*`/hop-counter; subprotocols negotiated end-to-end), client is
upgraded only after the upstream handshake succeeds → dial failures stay regular HTTP
errors (502/504/`onError`). Close code + reason propagate both ways. `timeout` bounds the
handshake only. N/A for tunnels: `maxRedirects`, `cache`, response transforms. The client leg
needs `info.upgradeWebSocket` (an adapter's `serve()`), see Special Behaviors #8. Upstream dial
uses the global `WebSocket` with `{ protocols, headers }` (works on Deno and Node ≥ 22).
Impl: `src/middleware/proxy/websocket.ts` (internal, not exported).

## trustProxy / proxy-aware ctx.url (since 1.15.0)

Behind a TLS-terminating reverse proxy (nginx/Cloudflare → app over plain HTTP on
e.g. `127.0.0.1:8888`), `req.url`'s scheme is `http:` on the proxy→app hop. Two
fixes:

**1. Same-origin redirects emit a RELATIVE `Location` (always on, trust-free).**
`redirect()` and `trailingSlash()` no longer use `Response.redirect` (which forces an
absolute URL). For a same-origin target they emit a relative `Location`
(`/path?query#hash`), so the client resolves it against the URL it actually used and
keeps its `https`. Cross-origin targets (`redirect("https://other.example")`) stay
absolute & unchanged. Same-origin is judged against `ctx.url`.

**2. `DeminoOptions.trustProxy` makes `ctx.url` proxy-aware (opt-in, default OFF).**

```ts
demino("", [], { trustProxy: { allowedHosts: ["example.com", "*.example.com"] } });
```

- `false`/unset → `ctx.url === new URL(req.url)` (forwarded headers never influence it).
- `true` → trust `X-Forwarded-Proto` only (`http|https`). Host NOT reflected.
- `{ allowedHosts }` → also trust `X-Forwarded-Host`/`-Port`, but ONLY when the
  forwarded host passes `isHostAllowed` (exact or `*.domain`). A non-matching forwarded
  host is dropped in favor of the request host. Empty/omitted `allowedHosts` trusts no
  forwarded host. **Recommended production form.**

Security model: forwarded headers are client-spoofable unless the origin is locked to
the trusted proxy — keep OFF unless that holds. Proto is low-risk (enum); host is
high-risk (forged host ⇒ cache poisoning / link hijack / open redirect) → allowlist
only. Only the LEFT-MOST (immediate-hop) header token is read, so the single trusted
proxy must OVERWRITE (not append) these headers (nginx default). The internal origin
port never leaks into an absolute self-URL. `resolveRequestUrl` is private (not
exported). Routing is unaffected (always `url.pathname`).

**`trustProxy` also gates `ctx.ip`** (behavior change in 1.15.0 — see below). With it
OFF, `ctx.ip` is the **direct socket peer** (`info.remoteAddr`) and `X-Forwarded-For`/
`X-Real-IP`/`CF-Connecting-IP` are ignored (a forged `X-Forwarded-For` has zero effect, and
`rateLimit()` keyed on `ctx.ip` can't be spoofed). With it ON, `ctx.ip` is resolved
from those forwarding headers via the exported `getClientIpFromHeaders()` (`X-Client-IP`,
left-most valid `X-Forwarded-For`, …), falling back to the socket. Previously `ctx.ip` trusted
`X-Forwarded-For` **ungated**.

## Context Logger Access

```ts
app.use((req, info, ctx) => {
	ctx.getLogger()?.debug?.("Debug message");
});
```

## Logger with Access Logging

```ts
import { createDeminoClog, demino } from "@marianmeres/demino";

const app = demino("", [], {
	logger: createDeminoClog("my-app"),
});

// Or from existing Clog instance:
import { createClog } from "@marianmeres/clog";
import { createDeminoClogFrom } from "@marianmeres/demino";

const myClog = createClog("my-app", { debug: true });
const app2 = demino("", [], {
	logger: createDeminoClogFrom(myClog),
});
```

---

## Recent Additions

### 2.0.0

- **Runtime adapters** `@marianmeres/demino/deno`, `/node`: one `serve(handler,
  options?) => Promise<ServeHandle>` (`ServeOptions`, `ServeHandle`, `ServeFn` exported from
  the root too). Node adapter = own `node:http` bridge (streams, backpressure, multi-`Set-Cookie`,
  `req.signal` on client abort, optional `ws` upgrades).
- **`DeminoServeInfo`** (`remoteAddr?`, `upgradeWebSocket?`, `raw?`) + `DeminoServeHandler`,
  `DeminoRemoteAddr`, `DeminoUpgradeWebSocket(Options)`.
- **`serveStatic()`** + `DeminoStaticOptions` / `ServeStaticOptions` / `DeminoStaticHeaders`
  (own static module on `node:fs`, content types via `mrmime`).
- **`DeminoListenAddr`** (what `onListen` receives); `getClientIpFromHeaders()` documented.
- **npm package** (dual-published; `engines.node >= 22`), subpath exports `./middleware`,
  `./misc`, `./router`, `./utils` now real.
- **Test suite on `node:test`**, green on Deno and Node; portability + manifest-sync
  guards; GitHub Actions matrix.

### 1.18.0 (additive, no breaking change)

- **Structured `onListen` logging.** `logListenInfo()` takes an optional second
  `LogListenInfoOptions` argument (`json`, `namespace`, `fields`, `write`) and the new
  `createLogListenInfo(options)` returns a preconfigured `onListen` callback. With
  `json: true` (or `"auto"` = JSON only when stdout is not a TTY) it emits a single JSON
  line — `timestamp`/`level`/`logger`/`message` (clog `jsonOutput` default field names)
  plus `event: "server.listen"`, `hostname`, `port`, `url`, and any `fields`. JSON mode
  deliberately skips the network-interface enumeration (container-local addresses are noise,
  and it avoids the system-info permission some runtimes require). Human mode is unchanged and
  still the default; interface enumeration there is wrapped in try/catch so a missing
  permission no longer throws out of `onListen`.

### 1.17.0 (additive, no breaking change)

- **`proxy()` WebSocket tunneling.** New `ProxyOptions.webSockets` (default `true`):
  well-formed WebSocket upgrade requests are tunneled to the upstream instead of being
  forwarded as a plain (never upgradable) GET. Upstream-dialed-first design keeps HTTP
  error semantics for failed handshakes (502/504/`onError`); full target policy + header
  forwarding (cookies/auth, `X-Forwarded-*`, hop-counter loop guard) + end-to-end
  subprotocol negotiation + bidirectional close propagation. `timeout` bounds the
  handshake only. See [Proxy](#proxy). Internal impl in
  `src/middleware/proxy/websocket.ts`; tests in `tests/middleware/proxy-websocket.test.ts`.
- **`proxy()` redirect re-validation.** Upstream redirects are followed manually and every
  hop re-checked against the self/SSRF/`allowedHosts` policy; bounded by new
  `ProxyOptions.maxRedirects` (default 5). Non-replayable 307/308 returned to the client
  unfollowed.

### 1.15.0 (additive, no breaking change)

- **Proxy-aware redirects + `ctx.url`.** Fixes `http://` `Location` headers emitted
  behind a TLS-terminating proxy. `redirect()` and `trailingSlash()` now emit a
  **relative** `Location` for same-origin targets (was absolute via `Response.redirect`)
  — trust-free, fixes every deployment. New opt-in `DeminoOptions.trustProxy`
  (`boolean | { allowedHosts }`, default OFF) rebuilds the new `ctx.url` from
  `X-Forwarded-Proto`/`-Host`/`-Port` for code that needs an absolute self-URL; host is
  reflected only against an `allowedHosts` allowlist. `proxy()` now derives its outbound
  `X-Forwarded-*` from `ctx.url` (correct chained-proxy scheme). See
  [trustProxy / proxy-aware ctx.url](#trustproxy--proxy-aware-ctxurl-since-1150). No new
  public symbol beyond `DeminoOptions.trustProxy` + `DeminoContext.url`
  (`resolveRequestUrl` stays private). **Behavior note:** a same-origin `redirect()` /
  `trailingSlash()` `Location` is now relative instead of absolute (functionally
  equivalent for clients) — a consumer asserting an absolute `Location` must update.
  `trustProxy` host trust validates the forwarded host **after** WHATWG URL parsing
  (so terminator chars like `evil.com#.example.com` can't smuggle a host past the
  allowlist), folds case, range-checks the port (1..65535), and rejects empty-label
  hosts. See also the **`ctx.ip`** behavior change under *Recent Breaking Changes*.

### 1.13.0 (additive, no breaking change)

- `bodyLimit({ maxSize, allowUnknownLength? })` middleware: pre-handler request body size
  gate that prevents memory exhaustion from large uploads. Header-only (never consumes
  `req.body`). `Content-Length` > `maxSize` → `413`; declared length is the read ceiling
  so it cannot be under-declared to bypass; body with no `Content-Length` (chunked) →
  `411` unless `allowUnknownLength: true`. `__midwareDuplicable` (strictest layered limit
  wins); NOT self-pinned to PRE. In `src/middleware/body-limit.ts`, exported via
  `@marianmeres/demino` (and `/middleware`).

### 1.11.0 (additive, no breaking change)

- `authz(...)` bundled middleware: generic, policy-free authorization gate over
  `ctx.routeMeta`. Opaque `check(subject, permission, ctx) => boolean` (wire rbac or
  anything; demino takes NO rbac dependency). Deny-by-default; OPTIONS bypass; auto-HEAD
  inherits GET's decl; runs in registration order (not self-pinned).
- `withPermission` / `withPublic`: route declaration sugar over `withMeta` (key
  `"authz"`).
- `getSubject<T>(ctx)`: typed subject accessor (avoids a viral `DeminoContext<L>`
  generic).
- `createRouteResolver(map)`: `(method, route) => decl` fallback matcher (`*`/`**`).
- `permissionMatrix(app)` / `assertCovered(app)`: build-time fail-closed coverage audit
  over `app.routes()` (the real guarantee — a runtime gate can't cover 404/405/static).
- All in `src/middleware/authz.ts`, exported via `@marianmeres/demino` (and
  `/middleware`).

### 1.10.0 (additive, no breaking change)

- `ctx.routeMeta` + `handler.meta` + `withMeta(meta, handler)`: static per-route metadata,
  stamped before any middleware runs (generic, not RBAC-specific)
- `app.routes()` (+ `DeminoRouteInfo`): enumerate `(method, route, meta)` for every
  registration — read-side companion for build-time audits/introspection
- `DEMINO_SORT` (`PRE`/`DEFAULT`/`HANDLER`): publishes middleware sort-order points

## Recent Breaking Changes

### 2.0.0

- **Runtime decoupling.** `src/` is web standards + `node:*` only; servers start through the
  runtime adapters (`@marianmeres/demino/deno`, `/node`). Published to JSR **and**
  npm (Node ≥ 22). Every forced consumer edit is sed-able (type renames).
  Consumer guide: [docs/MIGRATION-2.0.md](./docs/MIGRATION-2.0.md).
- **Handler info type:** `Deno.ServeHandlerInfo` → `DeminoServeInfo` (type-only;
  `remoteAddr?`, `upgradeWebSocket?`, `raw?`). `Demino` no longer extends
  `Deno.ServeHandler` but stays structurally compatible: `Deno.serve(app)` compiles and runs
  (`info` then carries `remoteAddr` only).
- **`app.static` options:** own `serveStatic()` on `node:fs` replaces `@std/http/serveDir`.
  `DeminoStaticOptions` = `showIndex`, `showDotfiles`, `etag`, `headers`
  (`HeadersInit | (req, filePath) => HeadersInit`). Removed: `enableCors` (use `cors()` on
  the mount), `quiet`, `showDirListing`, `etagAlgorithm`, `headers: string[]`. ETag values
  change once (weak `W/"<size>-<mtime>"`); static 301s emit a relative `Location`; bad
  percent-encoding is a 400.
- **`deminoFileBased` missing root:** throws a plain `Error` with `code: "ENOENT"`,
  `name: "NotFound"` (was `Deno.errors.NotFound`); `instanceof` checks → `code` checks.
- **`logListenInfo(addr)`** takes a `DeminoListenAddr` (`{ hostname, port }`); Deno's
  `onListen` argument still satisfies it (type-only).
- **Proxy WebSocket tunneling needs `info.upgradeWebSocket`** → an adapter's `serve()`. Under
  a bare `Deno.serve(app)` upgrade requests fall through to the HTTP path with one warning.
- **Dependencies:** removed `@std/*` and `request-ip` (inlined as `getClientIpFromHeaders()`,
  header precedence preserved, `Forwarded` dropped); added `mrmime`; optional `ws` peer for
  Node WebSocket upgrades.
- **Package exports:** `.`, `./deno`, `./node`, `./middleware`, `./misc`,
  `./router`, `./utils` (the barrel subpaths `AGENTS.md`/`mcp.ts` claimed before now
  resolve); npm `engines.node >= 22`.
- **Tests:** `node:test` + `node:assert/strict` (was `Deno.test` + `@std/assert`); the
  harness starts servers through the current runtime's adapter.

### 1.15.0

- **`ctx.ip` is now gated by `trustProxy`.** Previously `ctx.ip` trusted
  `X-Forwarded-For`/`X-Real-IP`/`CF-Connecting-IP` **ungated** (spoofable by any client
  that can reach the origin directly). Now: with `trustProxy` **off** (default),
  `ctx.ip` is the direct socket peer and those headers are ignored; with it **on**,
  `ctx.ip` is resolved from them, unchanged from before. **Action:**
  an app behind a proxy that reads `ctx.ip` (or keys `rateLimit()` on it) must set
  `trustProxy` to keep seeing the real client IP — otherwise `ctx.ip` becomes the
  proxy's address. This is the secure default and matches how `ctx.url` treats
  forwarded headers.

### 1.7.0

- **CORS** (`cors()`): default `allowCredentials` flipped from `true` → `false`. Combining
  `allowOrigin: "*"` with `allowCredentials: true` now throws `TypeError` (CORS spec
  violation). Dynamic `allowOrigin` resolving to `"*"` with credentials enabled refuses to
  set headers and warns.
- **Default logger**: `console as DeminoLogger` cast replaced with a real adapter that
  forwards `access` to `console.log`. Previously access logs were silently dropped.
- **`withTimeout(fn)`**: now invokes `fn(...args, signal)` so the wrappee can cancel its
  underlying work on timeout. Functions that ignore the extra arg work unchanged at
  runtime; TS callers may need to update signatures.
- **SSRF (`isPrivateHost`)**: now covers `0.0.0.0`, `::`, IPv4-mapped IPv6
  (`::ffff:1.2.3.4`), CGNAT `100.64/10`, and bracketed IPv6 hostnames.
- **`withETag()`**: new `maxSizeBytes` option (default 1 MiB). Bodies above the cap pass
  through unchanged with no ETag added. Pass `0`/`Infinity` to disable.

### Internal correctness fixes (1.7.0, no API change)

- `TokenBucket.refill()` no longer loses fractional refill time under fast successive
  calls (previously `Math.round(small)` returned 0 while `lastRefill` reset, permanently
  starving the bucket).
- `rateLimit()` now updates `lastAccess` on every request, so the periodic cleanup pass
  doesn't evict an active client (which would have reset their bucket to full capacity).
- `DeminoExpressLikeRouter.exec()` now uses `continue top` instead of `break top` on a
  static-segment mismatch, so a request for a later-registered route no longer 404s when
  an earlier route had a different static segment.
- `deminoFileBased()` Windows path normalization uses `replaceAll("\\", "/")` instead of
  `replace("\\", "/")` (only first backslash was being replaced).
- `app.info()` no longer reports `-1` middleware count for handler-less route
  registrations.

## Documentation Index

For deeper context, consult:

- [Architecture](./docs/architecture.md) — System design, runtime adapters, request lifecycle
- [Conventions](./docs/conventions.md) — Code style, portability rule, testing
- [Tasks](./docs/tasks.md) — Step-by-step procedures (running on each runtime, adding an
  adapter / dependency / middleware, verifying a change)
- [Migrating to 2.0](./docs/MIGRATION-2.0.md) — consumer-facing: every observable 2.0.0 change
  with before/after snippets and the `sed` recipe
- [Reverse proxies and `X-Forwarded-*` spoofing](./docs/reverse-proxy-and-forwarded-headers.md)
  — threat model behind `trustProxy`, `ctx.url`, and `ctx.ip` gating

Domain docs (consult when working in these areas):

- [Routing](./docs/domains/routing.md) — Router implementations and parameter syntax
- [Middleware](./docs/domains/middleware.md) — Built-in middleware reference
