# Architecture

## System Overview

Demino is a minimal web framework on web standards: a Demino app is a
`(req: Request, info?: DeminoServeInfo) => Promise<Response>` function. It adds routing,
middleware chaining, error handling, static file serving and logging on top of that one
signature. The core is runtime-agnostic (web APIs plus the `node:*` subset); a thin **runtime
adapter** per runtime (`/deno`, `/node`) owns the HTTP server, fills in `info` and
returns a uniform `ServeHandle`.

## Component Map

```
serve(app)   ← @marianmeres/demino/deno | /node
     │         (runtime adapter: owns the server, builds the Request,
     │          fills DeminoServeInfo, writes the Response back)
     ▼
┌─────────────────────────────────────────────────────┐
│                    Demino App                        │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  │
│  │   Router    │  │  Middleware │  │   Logger    │  │
│  │             │  │   Chain     │  │             │  │
│  │ - match()   │  │ - global    │  │ - error     │  │
│  │ - params    │  │ - route     │  │ - access    │  │
│  │             │  │ - method    │  │ - debug     │  │
│  └─────────────┘  └─────────────┘  └─────────────┘  │
│         │                │                          │
│         └───────┬────────┘                          │
│                 ▼                                   │
│        ┌─────────────┐      ┌─────────────┐         │
│        │  Context    │      │   Static    │         │
│        │  - params   │      │ serveStatic │         │
│        │  - locals   │      │  (node:fs)  │         │
│        │  - headers  │      └─────────────┘         │
│        │  - status   │                              │
│        └─────────────┘                              │
│                 │                                   │
│                 ▼                                   │
│        ┌─────────────┐                              │
│        │  Response   │                              │
│        │  Converter  │                              │
│        └─────────────┘                              │
└─────────────────────────────────────────────────────┘
```

## Runtime Adapters

| Adapter | File                   | Server underneath                      | `info.remoteAddr` | `info.upgradeWebSocket`                                                  | `info.raw`          |
| ------- | ---------------------- | -------------------------------------- | ----------------- | ------------------------------------------------------------------------ | ------------------- |
| Deno    | `src/adapters/deno.ts` | the built-in HTTP server               | yes               | `Deno.upgradeWebSocket`                                                  | Deno's handler info |
| Node    | `src/adapters/node.ts` | own bridge over `node:http` (HTTP/1.1) | yes               | via the optional `ws` package (absent if missing or `webSockets: false`) | `IncomingMessage`   |
- **Contract**: `src/adapters/types.ts` — `ServeOptions`, `ServeHandle`, `ServeFn` (plus the
  internal `toUrl`). Handler-side types `DeminoServeHandler`, `DeminoServeInfo`,
  `DeminoRemoteAddr`, `DeminoUpgradeWebSocket` live in `src/demino.ts`. The core imports
  nothing from `adapters/` except `types.ts`; no adapter imports another.
- **One signature**: `serve(handler, options?) => Promise<ServeHandle>`; defaults
  `0.0.0.0:8000`, `onListen: logListenInfo`. `signal` abort = forceful close of listener and
  every connection; `shutdown()` = graceful, Node forces after 5 s.
- **WebSocket contract**: `upgradeWebSocket(req, { protocol? })` returns `{ socket, response }`;
  the socket is CONNECTING until the handler has returned the 101, then fires `open`. Node
  (`ws` sockets are born open) holds frames back until then, so the same handler code works on
  both.
- **Flat shims**: `src/deno.ts`, `src/node.ts` re-export their adapter; the
  `deno.json` exports map points at these, the `package.json` one at their `tsc` output in
  `dist/`.
- **Without an adapter**: on Deno the app is structurally a Deno serve handler and can be
  handed to the runtime directly (`info` then has `remoteAddr` only — no upgrade capability).
  Node has no web-standard server; the adapter is required.
- **Bun is not a supported runtime**: a Demino app is a web-standard handler, so
  `Bun.serve({ fetch: app })` serves plain HTTP; `ctx.ip` from the socket and WebSocket
  tunneling are not available there, and nothing is tested on Bun.

### Portability invariant

`src/` outside `src/adapters/` never touches a runtime global. Enforced by
`tests/portability.test.ts` (see [Conventions → Portability](./conventions.md#portability)):
no `Deno.` outside the adapters, the name `Deno` only in `src/adapters/deno.ts` and `Bun`
nowhere (not a supported runtime), no `@std/` / `jsr:` / `npm:` / `https:` specifiers in
`src/`, erasable-only TypeScript.

## Data Flow

### Request Lifecycle

1. **Incoming Request** → the runtime adapter's server (or the runtime's own server, without an
   adapter) builds the `Request`, fills `DeminoServeInfo` and invokes the Demino handler
2. **Route Matching** → Router finds matching route pattern, extracts params
3. **Context Creation** → Fresh `DeminoContext` created with params, headers, `ctx.url`,
   `ctx.ip` (from `info.remoteAddr`, or the forwarding headers when `trustProxy` is on), etc.
4. **Middleware Stack Resolution** (since 1.7.0) → Look up `(method, route)` in the
   middleware cache. If absent, assemble + sort and store the resulting `Midware`
   instance. The cache is invalidated on `app.use(...)` or route (re-)registration.
5. **Middleware Execution** → Cached chain executes in order:
   - Global app middlewares (`app.use(mw)`)
   - Route-global middlewares (`app.use("/route", mw)`)
   - Route-method middlewares (`app.get("/route", mw, handler)`)
6. **Handler Execution** → Final handler (last argument to route method)
7. **Response Conversion** → Return value converted to `Response`
8. **Error Handling** → If error thrown, error handler invoked
9. **Access Logging** → `logger.access` invoked (default logger forwards to `console.log`
   prefixed `[access]`; pass a custom logger or `null` to change/disable)
10. **Write back** → the adapter writes the `Response` onto the runtime's connection (Node:
    streamed with backpressure, multi-`Set-Cookie` preserved)

### Termination Rules

- First non-undefined return from middleware stops chain
- Error thrown anywhere triggers error handler
- HEAD requests auto-generated from GET handlers

## External Dependencies

### Runtime (published, in both `deno.json` and `package.json`)

| Package                      | Purpose                                 |
| ---------------------------- | --------------------------------------- |
| `@marianmeres/http-utils`    | HTTP errors, status codes               |
| `@marianmeres/midware`       | Middleware chaining                     |
| `@marianmeres/simple-router` | Default router implementation           |
| `@marianmeres/clog`          | Structured logging (`createDeminoClog`) |
| `mrmime`                     | Content types for static files          |

### Optional peer (npm)

| Package | Purpose                                                                                   |
| ------- | ----------------------------------------------------------------------------------------- |
| `ws`    | WebSocket upgrades in the Node adapter (lazily imported; absent = HTTP only, one warning) |

### Built-ins

`node:fs`, `node:path`, `node:url` (static files, file-based routing), `node:os` (listen info),
`node:net` (IP validation), `node:http` + `node:stream` (Node adapter only). No `@std/*`
anywhere in `src/`.

## Key Files

| File                              | Responsibility                                                                                        |
| --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `src/demino.ts`                   | Core: `demino()` factory, `Demino` interface, `DeminoContext`, `DeminoServeInfo`, response conversion |
| `src/adapters/types.ts`           | Adapter contract: `ServeOptions`, `ServeHandle`, `ServeFn`                                            |
| `src/adapters/deno.ts`            | Deno adapter (built-in server)                                                                        |
| `src/adapters/node.ts`            | Node adapter (own `node:http` bridge, optional `ws`)                                                  |
| `src/static/serve-static.ts`      | `serveStatic()` + `DeminoStaticOptions` (what `app.static()` calls)                                   |
| `src/static/mime.ts`              | Content-type lookup (`mrmime`)                                                                        |
| `src/router/abstract.ts`          | `DeminoRouter` base class                                                                             |
| `src/router/simple-router.ts`     | Default router (bracket params: `/users/[id]`)                                                        |
| `src/router/urlpattern-router.ts` | URL Pattern API router (`:id` params)                                                                 |
| `src/middleware/mod.ts`           | Built-in middleware exports                                                                           |
| `src/misc/compose.ts`             | `deminoCompose()` for multi-app                                                                       |
| `src/misc/file-based.ts`          | Directory-based routing (`node:fs`)                                                                   |
| `src/utils/client-ip.ts`          | `getClientIpFromHeaders()` (forwarding-header precedence)                                             |
| `src/utils/log-listen-info.ts`    | `logListenInfo()`, `DeminoListenAddr` (every adapter's default `onListen`)                            |

## Extension Points

- **Static route metadata.** Handlers can carry `.meta` (set via `withMeta()`), surfaced
  as the frozen `ctx.routeMeta` (stamped before any middleware runs) and enumerable via
  `app.routes()` for build-time route introspection. A generic primitive — use it for
  auth, rate-limit tiers, cache policy, audit tags, telemetry, OpenAPI, etc.
- **Authorization.** `authz` is the bundled generic authorization gate built on
  `routeMeta` / `app.routes()`; Demino keeps no rbac dependency. See
  [domains/middleware.md](./domains/middleware.md#authz) and
  [API.md](../API.md#authz).
- **Runtime adapters.** Any `ServeFn` implementation is an adapter; see
  [Tasks → Adding a Runtime Adapter](./tasks.md#adding-a-runtime-adapter).
- **Static wrappers.** `serveStatic()` is exported for serving files under a custom route
  with custom per-request headers.

## Security Boundaries

Demino is a building-blocks framework. Security is delegated to:

- **Authentication/Authorization**: Implement via middleware (or use the bundled `authz`
  gate — generic and policy-free; see [domains/middleware.md](./domains/middleware.md#authz))
- **Input validation**: Implement via middleware or handlers
- **CORS**: Use bundled `cors()` middleware
- **Rate limiting**: Use bundled `rateLimit()` middleware
- **SSRF protection**: Use `proxy()` middleware with `preventSSRF: true` (and/or
  `allowedHosts`). Blocks private/loopback/link-local/CGNAT targets (IPv4, IPv6, and
  IPv4-mapped/NAT64 forms) and re-validates every redirect hop. String-only check — see the
  DNS-rebinding caveat in [domains/middleware.md](./domains/middleware.md#proxy)
- **Static files**: `serveStatic()` normalises and containment-checks every path (no escape
  from `fsRoot`, dotfiles hidden by default, `%5C`/NUL rejected)
- **TLS**: not handled — every adapter speaks plain `http:`; terminate TLS in a reverse
  proxy and see [reverse-proxy-and-forwarded-headers.md](./reverse-proxy-and-forwarded-headers.md)

The framework does NOT provide built-in:

- Session management
- CSRF protection
- Content Security Policy headers

These should be implemented as needed per application requirements.
