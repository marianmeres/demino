# AGENTS.md - Demino Package Knowledge Base

Machine-friendly documentation for AI agents working with @marianmeres/demino.

## Package Identity

- **Name**: @marianmeres/demino
- **Registry**: JSR (jsr.io/@marianmeres/demino)
- **Version**: 1.4.6 (BETA)
- **Runtime**: Deno
- **Type**: Web server framework
- **Entry Point**: src/mod.ts

## Core Concept

Demino is a minimal web framework built on Deno's native HTTP server. It provides a thin layer over `Deno.serve()` with routing, middleware, error handling, and logging.

**Key Philosophy**: "Batteries NOT included" - provides building blocks, not a full-featured server.

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
  ctx: DeminoContext
) => any | Promise<any>
```

### DeminoContext
```ts
interface DeminoContext {
  params: Record<string, string>;    // Route params (frozen)
  locals: Record<string, any>;       // Request-scoped storage
  headers: Headers;                  // Response headers
  status: number;                    // Response status
  route: string;                     // Matched route pattern
  ip: string;                        // Client IP
  error: any;                        // Error ref (error handlers)
  appLocals: any;                    // App-wide persistent data
  getLogger(): DeminoLogger | null;
  __start: Date;                     // Request timestamp
}
```

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
  getOptions(): DeminoOptions;
  locals: DeminoAppLocals;           // App-wide persistent data (ctx.appLocals)
}
```

## Response Conversion Rules

Handler return values are auto-converted to Response:

| Return Type | Conversion |
|-------------|------------|
| `undefined` | 204 No Content |
| `null` | JSON `null` |
| Plain object/array | JSON stringified |
| `toJSON()` objects | JSON stringified |
| `Response` | Pass through |
| `Error` | Error response |
| Other | `toString()` as text/html |

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

## Middleware Execution

1. Global app middlewares (`app.use(mw)`)
2. Route-global middlewares (`app.use("/route", mw)`)
3. Route-method middlewares (`app.get("/route", mw, handler)`)
4. Final handler (last argument to route method)

**Termination**: First non-undefined return stops chain.

**Sort Order**: Use `__midwarePreExecuteSortOrder` property to control position.

**Duplicates**: Set `__midwareDuplicable = true` to allow multiple instances.

## Dependencies

### JSR
- @marianmeres/http-utils - HTTP errors/status codes
- @marianmeres/midware - Middleware chaining
- @marianmeres/simple-router - Default router implementation
- @std/assert - Test assertions
- @std/encoding - Encoding utilities (base64)
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
api.get("/users", getUsers);  // handles /api/users
```

### Middleware Registration
```ts
app.use(globalMw);                    // All routes
app.use("/protected", authMw);        // Specific route
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
2. **Trailing slashes**: `/foo` and `/foo/` are equivalent (use trailingSlash middleware to enforce)
3. **Error logging**: All errors except 404s logged via `logger.error()`
4. **Access logging**: Only if `logger.access` provided
5. **Mount path validation**: Must start with `/`, cannot end with `/`, no dynamic segments

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
app.use("/api", rateLimit(
  (req, info, ctx) => req.headers.get("Authorization"),
  { maxSize: 20, refillSizePerSecond: 10 }
));
```

## Proxy

```ts
app.get("/api/*", proxy("https://backend/*", {
  preventSSRF: true,
  timeout: 30000
}));
```

## Context Logger Access

```ts
app.use((req, info, ctx) => {
  ctx.getLogger()?.debug?.("Debug message");
});
```

## Logger with Access Logging

```ts
import { demino, createDeminoClog } from "@marianmeres/demino";

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

## Documentation Index

For deeper context, consult:

- [Architecture](./docs/architecture.md) — System design, components, request lifecycle
- [Conventions](./docs/conventions.md) — Code style, patterns, error handling
- [Tasks](./docs/tasks.md) — Step-by-step common procedures

Domain docs (consult when working in these areas):
- [Routing](./docs/domains/routing.md) — Router implementations and parameter syntax
- [Middleware](./docs/domains/middleware.md) — Built-in middleware reference
