# Architecture

## System Overview

Demino is a minimal web framework providing a thin layer over `Deno.serve()`. It adds
routing, middleware chaining, error handling, and logging while remaining compatible with
the native Deno HTTP server API.

## Component Map

```
Deno.serve(app)
     │
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
│        ┌─────────────┐                              │
│        │  Context    │                              │
│        │  - params   │                              │
│        │  - locals   │                              │
│        │  - headers  │                              │
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

## Data Flow

### Request Lifecycle

1. **Incoming Request** → `Deno.serve()` invokes Demino handler
2. **Route Matching** → Router finds matching route pattern, extracts params
3. **Context Creation** → Fresh `DeminoContext` created with params, headers, etc.
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

### Termination Rules

- First non-undefined return from middleware stops chain
- Error thrown anywhere triggers error handler
- HEAD requests auto-generated from GET handlers

## External Dependencies

### JSR Packages

| Package                      | Purpose                          |
| ---------------------------- | -------------------------------- |
| `@marianmeres/http-utils`    | HTTP errors, status codes        |
| `@marianmeres/midware`       | Middleware chaining              |
| `@marianmeres/simple-router` | Default router implementation    |
| `@marianmeres/clog`          | Structured logging (optional)    |
| `@std/http`                  | Static file serving              |
| `@std/path`                  | Path utilities                   |
| `@std/fs`                    | File system (file-based routing) |

### NPM Packages

| Package      | Purpose             |
| ------------ | ------------------- |
| `request-ip` | Client IP detection |

## Key Files

| File                              | Responsibility                                                                     |
| --------------------------------- | ---------------------------------------------------------------------------------- |
| `src/demino.ts`                   | Core: `demino()` factory, `Demino` interface, `DeminoContext`, response conversion |
| `src/router/abstract.ts`          | `DeminoRouter` base class                                                          |
| `src/router/simple-router.ts`     | Default router (bracket params: `/users/[id]`)                                     |
| `src/router/urlpattern-router.ts` | URL Pattern API router (`:id` params)                                              |
| `src/middleware/mod.ts`           | Built-in middleware exports                                                        |
| `src/misc/compose.ts`             | `deminoCompose()` for multi-app                                                    |
| `src/misc/file-based.ts`          | Directory-based routing                                                            |

## Extension Points

- **Static route metadata.** Handlers can carry `.meta` (set via `withMeta()`), surfaced
  as the frozen `ctx.routeMeta` (stamped before any middleware runs) and enumerable via
  `app.routes()` for build-time route introspection. A generic primitive — use it for
  auth, rate-limit tiers, cache policy, audit tags, telemetry, OpenAPI, etc.
- **Authorization.** `authz` is the bundled generic authorization gate built on
  `routeMeta` / `app.routes()`; Demino keeps no rbac dependency. See
  [domains/middleware.md](./domains/middleware.md#authz) and
  [API.md](../API.md#authz).

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

The framework does NOT provide built-in:

- Session management
- CSRF protection
- Content Security Policy headers

These should be implemented as needed per application requirements.
