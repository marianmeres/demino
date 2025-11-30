# CLAUDE.md - Demino Project Knowledge Base

> Machine-friendly documentation for AI assistants. Last updated: 2025-11-30

## Quick Reference

| Property | Value |
|----------|-------|
| Package | `@marianmeres/demino` |
| Version | 1.1.0 |
| Runtime | Deno |
| Entry Point | `src/mod.ts` |
| Main Source | `src/demino.ts` |
| License | MIT |

## What is Demino?

Demino is a **minimalist web server framework** for Deno built on `Deno.serve`. It provides routing, middleware, error handling, and logging as thin syntactic sugar over Deno's built-in HTTP server. It's intentionally NOT a batteries-included framework.

## Project Structure

```
src/
├── demino.ts              # Core app factory, types, main logic (~600 lines)
├── mod.ts                 # Public API re-exports
├── router/                # 6 router implementations
│   ├── abstract.ts        # DeminoRouter base class
│   ├── simple-router.ts   # DEFAULT: uses @marianmeres/simple-router
│   ├── urlpattern-router.ts
│   ├── express-like-router.ts  # DEPRECATED
│   ├── fixed-router.ts    # Simple string comparison
│   ├── regex-router.ts    # Full regex support
│   └── mod.ts
├── middleware/            # Built-in middleware
│   ├── cors.ts
│   ├── cookies.ts
│   ├── trailing-slash.ts
│   ├── redirect.ts
│   ├── rate-limit.ts
│   ├── etag.ts
│   ├── proxy/
│   │   ├── proxy.ts
│   │   └── utils.ts       # SSRF protection
│   └── mod.ts
├── misc/
│   ├── compose.ts         # Multi-app composition
│   ├── file-based.ts      # Directory-based routing
│   └── mod.ts
├── utils/
│   ├── cookies.ts         # Cookie parsing/serialization
│   ├── token-bucket.ts    # Rate limiting algorithm
│   ├── with-timeout.ts
│   ├── sleep.ts
│   ├── is-plain-object.ts
│   ├── is-valid-date.ts
│   ├── is-fn.ts
│   └── mod.ts
└── _tests/                # Test suite
    ├── demino.test.ts
    ├── middleware/
    ├── router/
    ├── misc/
    ├── _utils.ts          # Test helpers
    └── fixtures/          # File-based routing fixtures
```

## Core Architecture

### Request Flow

```
Request → URL Parse → Router Match → Middleware Chain → Response
                           ↓
                     Handler Execution
                           ↓
                   Auto Response Creation
                           ↓
                   X-Headers Addition
                           ↓
                 Access Log + Error Log
```

### Key Design Patterns

1. **Handlers ARE Middlewares**: Route handlers are the final middleware in chain
2. **Three Registration Levels**:
   - App-global: `app.use(mw)` - all routes
   - Route-global: `app.use("/path", mw)` - all methods on route
   - Local: `app.get("/path", mw, handler)` - specific method
3. **Automatic Response Conversion**:
   - `undefined` → 204 No Content
   - Objects/arrays/null → JSON (`application/json`)
   - Error → Error response (custom handler available)
   - Other → `toString()` as `text/html`
4. **Router Abstraction**: Factory pattern via `routerFactory` option

## Public API

### Main Factory

```typescript
demino(
  mountPath?: string,
  middleware?: DeminoHandler | DeminoHandler[],
  options?: DeminoOptions,
  appLocals?: DeminoAppLocals
): Demino
```

### Demino Methods

```typescript
// Route registration
.get(route, ...handlers)
.post(route, ...handlers)
.put(route, ...handlers)
.patch(route, ...handlers)
.delete(route, ...handlers)
.options(route, ...handlers)
.head(route, ...handlers)  // Warning: auto-handled from GET
.trace(route, ...handlers)
.connect(route, ...handlers)
.all(route, ...handlers)   // Any HTTP method

// Management
.use(...args)              // Register middleware
.error(handler)            // Custom error handler
.static(route, fsRoot, options?)  // Serve static files
.logger(logger)            // Set/unset logger
.getOptions()              // Get constructor options
.info()                    // Debug info
.mountPath()               // Get mount path
```

### Handler Signature

```typescript
type DeminoHandler = (
  req: Request,
  info: Deno.ServeHandlerInfo,
  ctx: DeminoContext
) => any | Promise<any>
```

### DeminoContext Object

```typescript
{
  params: Record<string, string>;   // Route params (readonly)
  locals: Record<string, any>;      // Request-scoped data
  appLocals: DeminoAppLocals;       // App-level persistent data
  headers: Headers;                 // Response headers
  status: number;                   // HTTP status
  ip: string;                       // Client IP
  route: string;                    // Matched route pattern
  error: any;                       // Error object (in error handler)
  __start: Date;                    // Request timestamp
  getLogger: () => DeminoLogger | null;
}
```

### Configuration Options

```typescript
interface DeminoOptions {
  routerFactory?: () => DeminoRouter;
  noXPoweredBy?: boolean;
  noXResponseTime?: boolean;
  verbose?: boolean;
  logger?: DeminoLogger;
  errorHandler?: DeminoHandler;
}
```

## Built-in Middleware

| Middleware | Import | Purpose |
|------------|--------|---------|
| `cors(options?)` | `middleware/cors.ts` | CORS support, dynamic origin validation |
| `cookies(defaults?)` | `middleware/cookies.ts` | Cookie parsing, setCookie/deleteCookie helpers |
| `trailingSlash(flag, options?)` | `middleware/trailing-slash.ts` | URL normalization via 301 |
| `redirect(url, status?)` | `middleware/redirect.ts` | HTTP redirects |
| `rateLimit(getClientId, options?)` | `middleware/rate-limit.ts` | Token bucket rate limiting |
| `withETag(handler, options?)` | `middleware/etag.ts` | ETag generation, 304 responses |
| `proxy(target, options?)` | `middleware/proxy/proxy.ts` | Request proxying, SSRF protection |

## Router Implementations

| Router | File | Pattern Syntax | Use Case |
|--------|------|----------------|----------|
| `DeminoSimpleRouter` | `simple-router.ts` | `/users/[id]`, `/*` | DEFAULT, recommended |
| `DeminoUrlPatternRouter` | `urlpattern-router.ts` | `/users/:id` | URL Pattern API |
| `DeminoRegexRouter` | `regex-router.ts` | `/users/(?<id>\\d+)` | Complex patterns |
| `DeminoFixedRouter` | `fixed-router.ts` | Exact strings only | Simple cases |
| `DeminoExpressLikeRouter` | `express-like-router.ts` | `/users/:id` | DEPRECATED |

## Composition & File-Based Routing

```typescript
// Multi-app composition
deminoCompose(apps: Demino[], notFoundHandler?): Deno.ServeHandler

// Directory-based routing
deminoFileBased(app: Demino, rootDirs: string | string[], options?): Promise<Demino>
```

### File-Based Routing Conventions
- `_middleware.ts` - Route middleware (exports `default`)
- Files starting with `_` or `.` are ignored
- Directory structure maps to routes

## Dependencies

### Core
- `@marianmeres/midware` ^1.2.0 - Middleware composition
- `@marianmeres/simple-router` ^2.2.1 - Default router
- `@marianmeres/http-utils` ^2.0.1 - HTTP status, errors
- `@marianmeres/clog` ^3.0.0 - Logger interface

### Standard Library
- `@std/http` ^1.0.22 - Static file serving
- `@std/path` ^1.1.3 - Path manipulation
- `@std/fmt` ^1.0.8 - Console colors
- `@std/fs` ^1.0.20 - File system
- `@std/encoding` ^1.0.10 - Base64

### NPM
- `request-ip` ^3.3.0 - Client IP extraction

## Coding Conventions

### File Naming
- kebab-case: `trailing-slash.ts`, `file-based.ts`
- Tests: `*.test.ts`
- Special: `_middleware.ts` (file-based routing)
- Ignored: `_*`, `.*`

### Naming Patterns
- Functions: camelCase
- Types/Interfaces: PascalCase with `Demino*` prefix
- Constants: UPPER_SNAKE_CASE
- Private fields: `#fieldName`
- Internal helpers: `_functionName`

### Code Style
- Tabs (4-space width), NOT spaces
- Line width: 90 characters
- JSDoc with `@example`, `@param`, `@returns`
- ES6 imports/exports
- Async/await preferred
- Lint rule disabled: `no-explicit-any`

## Common Tasks

### Create Basic App
```typescript
import { demino } from "@marianmeres/demino";

const app = demino();
app.get("/", () => "Hello World");

Deno.serve(app);
```

### Add Middleware
```typescript
// Global
app.use(cors());

// Route-specific
app.use("/api", authMiddleware);

// Local
app.get("/admin", authMiddleware, adminOnly, handler);
```

### Custom Error Handler
```typescript
app.error((req, info, ctx) => {
  return new Response(ctx.error.message, { status: ctx.status });
});
```

### Mount Path (Sub-app)
```typescript
const api = demino("/api/v1");
api.get("/users", getUsers);  // Responds to /api/v1/users
```

### Static Files
```typescript
app.static("/public", "./public");
```

### Compose Apps
```typescript
const main = demino();
const admin = demino("/admin");

Deno.serve(deminoCompose([main, admin]));
```

## Testing

### Run Tests
```bash
deno task test          # Watch mode
deno task test:no-watch # Single run
```

### Test Helpers (from `_tests/_utils.ts`)
- `startTestServer(app)` - Start test server, returns port
- `assertResp(resp, expected)` - Assert response properties
- `runTestServerTests(app, tests)` - Run test suite against app

## Key Files for Understanding

| Purpose | File |
|---------|------|
| Core logic | `src/demino.ts` |
| Public exports | `src/mod.ts` |
| Router base | `src/router/abstract.ts` |
| Default router | `src/router/simple-router.ts` |
| Main tests | `src/_tests/demino.test.ts` |
| Example middleware | `src/middleware/cors.ts` |

## Important Implementation Details

1. **Context is sealed**: `Object.seal(ctx)` prevents adding properties
2. **Middleware sorting**: Use `__midwarePreExecuteSortOrder` property
3. **Duplicate detection**: Middlewares are checked for duplicates (mark with `__midwareDuplicable = true` to allow)
4. **HEAD auto-handling**: GET handlers automatically respond to HEAD
5. **X-Powered-By**: Added by default (disable with `noXPoweredBy: true`)
6. **X-Response-Time**: Added by default (disable with `noXResponseTime: true`)

## Error Handling

- Custom handler via `app.error(handler)`
- Default uses `getErrorMessage` from http-utils
- Non-404 errors logged automatically
- HTTP status preserved from error's `status` property
- `ctx.error` available in error handler

## Logger Interface

```typescript
interface DeminoLogger {
  error?: (...args: any[]) => void;
  warn?: (...args: any[]) => void;
  log?: (...args: any[]) => void;
  debug?: (...args: any[]) => void;
  access?: (data: {
    timestamp: Date;
    status: number;
    req: Request;
    ip: string | undefined;
    duration: number;
  }) => void;
}
```

## What Demino Does NOT Include

- Database/ORM integration
- Templating engines
- Form validation
- Authentication/authorization
- WebSocket support
- Session management
- CLI tools

These are intentionally left to the user to implement or integrate.
