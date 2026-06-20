# AGENTS.md - Demino Package Knowledge Base

Machine-friendly documentation for AI agents working with @marianmeres/demino.

## Package Identity

- **Name**: @marianmeres/demino
- **Registry**: JSR (jsr.io/@marianmeres/demino)
- **Version**: 1.11.0
- **Runtime**: Deno
- **Type**: Web server framework
- **Entry Point**: src/mod.ts

## Core Concept

Demino is a minimal web framework built on Deno's native HTTP server. It provides a thin
layer over `Deno.serve()` with routing, middleware, error handling, and logging.

**Key Philosophy**: "Batteries NOT included" - provides building blocks, not a
full-featured server.

## Architecture Overview

```
demino()           -> Demino app (implements Deno.ServeHandler)
  |
  ├── Router       -> Route matching (DeminoSimpleRouter default)
  ├── Middleware   -> Chain of DeminoHandler functions
  ├── Context      -> Request-scoped DeminoContext
  └── Response     -> Auto-generated from handler returns
```

## File Structure

```
src/
├── mod.ts                    # Main exports barrel
├── demino.ts                 # Core: demino(), Demino, DeminoContext, types
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
│       └── utils.ts          # Proxy utility functions
├── misc/
│   ├── mod.ts                # Misc exports barrel
│   ├── compose.ts            # deminoCompose() multi-app
│   └── file-based.ts         # Directory-based routing
└── utils/
    ├── mod.ts                # Utils exports barrel
    ├── create-demino-clog.ts # DeminoLogger factory using @marianmeres/clog
    ├── log-listen-info.ts    # logListenInfo() for Deno.serve onListen callback
    ├── token-bucket.ts       # TokenBucket class
    ├── cookies.ts            # parseCookies, serializeCookie
    ├── sleep.ts              # Promise delay
    ├── with-timeout.ts       # Timeout wrapper
    ├── is-fn.ts              # Function type guard
    ├── is-plain-object.ts    # Plain object type guard
    └── is-valid-date.ts      # Date type guard

tests/                        # Test suite
├── demino.test.ts            # Core framework tests
├── _utils.ts                 # Test utilities
├── middleware/               # Middleware tests
├── router/                   # Router tests
├── misc/                     # Feature tests
├── fixtures/                 # File-based routing fixtures
└── static/                   # Static file serving test files
```

## Critical Types

### DeminoHandler

```ts
type DeminoHandler = (
	req: Request,
	info: Deno.ServeHandlerInfo,
	ctx: DeminoContext,
) => any | Promise<any>;
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
	ip: string; // Client IP
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
interface Demino extends Deno.ServeHandler {
  get/post/put/patch/delete/head/options/connect/trace/all: DeminoRouteHandler;
  use(...args): Demino;              // Register middleware
  error(handler): Demino;            // Set error handler
  static(route, fsRoot, options?): Demino;
  logger(logger): Demino;
  mountPath(): string;
  info(): { routes, globalAppMiddlewaresCount };
  routes(): DeminoRouteInfo[];       // Enumerate (method, route, meta) per registration
  getOptions(): DeminoOptions;
  locals: DeminoAppLocals;           // App-wide persistent data (ctx.appLocals)
}
```

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

### JSR

- @marianmeres/http-utils - HTTP errors/status codes
- @marianmeres/midware - Middleware chaining
- @marianmeres/simple-router - Default router implementation
- @std/assert - Test assertions
- @std/fmt - Formatting utilities (colors)
- @std/fs - File system utilities (walkSync)
- @std/http - HTTP utilities (serveDir)
- @std/path - Path utilities

### NPM

- request-ip - Client IP detection

## Common Patterns

### Basic App

```ts
const app = demino();
app.get("/", () => "Hello");
Deno.serve(app);
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
Deno.serve(deminoCompose([app, api]));
```

### File-Based Routing

```ts
const app = demino();
await deminoFileBased(app, "./routes");
```

## Testing

```bash
deno test -A              # Run all tests
deno task test            # Run all tests (shorthand)
deno task test:watch      # Run tests in watch mode
```

Test files located in: `tests/`

## Deno Tasks

```bash
deno task dev             # Run main module with watch
deno task test            # Run all tests
deno task test:watch      # Run tests in watch mode
deno task release         # Publish to JSR
```

## Special Behaviors

1. **HEAD requests**: Auto-generated from GET handlers
2. **Trailing slashes**: `/foo` and `/foo/` are equivalent (use trailingSlash middleware
   to enforce)
3. **Error logging**: All errors except 404s logged via `logger.error()`
4. **Access logging**: Default logger forwards `access` to `console.log` (since 1.7.0).
   Set `logger: null` or override `access` to silence.
5. **Mount path validation**: Must start with `/`, cannot end with `/`, no dynamic
   segments
6. **Per-(method, route) middleware caching** (since 1.7.0): The assembled `Midware` for
   each route is built once on the first matching request and reused. The cache is
   invalidated when `app.use(...)` runs or when a route is (re-)registered.
7. **File-based missing root dir**: `deminoFileBased()` throws `Deno.errors.NotFound`
   (`code: "ENOENT"`) when a root directory is absent — fail-loud at boot, not a
   silently-empty app. Pass `ignoreMissingRootDir: true` to skip absent roots with a
   `logger.warn`. A root that exists but is not a directory always throws `TypeError`.

## Common Modifications

### Add New Middleware

1. Create file in `src/middleware/`
2. Export factory function returning `DeminoHandler`
3. Add export to `src/middleware/mod.ts`

### Add New Router

1. Extend `DeminoRouter` abstract class
2. Implement `on()` and `exec()` methods
3. Use via `routerFactory` option

### Add New Utility

1. Create file in `src/utils/`
2. Add export to `src/utils/mod.ts`

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
app.static("/files", "/path/to/dir", options?);
// Uses @std/http/serveDir internally
```

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
DNS-rebinding-resistant SSRF protection, resolve via `Deno.resolveDns` and re-check each
result.

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
OFF, `ctx.ip` is the **direct socket peer** and `X-Forwarded-For`/`X-Real-IP`/
`CF-Connecting-IP` are ignored (a forged `X-Forwarded-For` has zero effect, and
`rateLimit()` keyed on `ctx.ip` can't be spoofed). With it ON, `ctx.ip` is resolved
from those forwarding headers (via `request-ip`, left-most `X-Forwarded-For`), falling
back to the socket. Previously `ctx.ip` trusted `X-Forwarded-For` **ungated**.

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

### 1.15.0

- **`ctx.ip` is now gated by `trustProxy`.** Previously `ctx.ip` trusted
  `X-Forwarded-For`/`X-Real-IP`/`CF-Connecting-IP` **ungated** (spoofable by any client
  that can reach the origin directly). Now: with `trustProxy` **off** (default),
  `ctx.ip` is the direct socket peer and those headers are ignored; with it **on**,
  `ctx.ip` is resolved from them (via `request-ip`), unchanged from before. **Action:**
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

- [Architecture](./docs/architecture.md) — System design, components, request lifecycle
- [Conventions](./docs/conventions.md) — Code style, patterns, error handling
- [Tasks](./docs/tasks.md) — Step-by-step common procedures

Domain docs (consult when working in these areas):

- [Routing](./docs/domains/routing.md) — Router implementations and parameter syntax
- [Middleware](./docs/domains/middleware.md) — Built-in middleware reference
