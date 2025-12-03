# Demino API Reference

Complete API documentation for `@marianmeres/demino`.

## Table of Contents

- [Core](#core)
  - [demino()](#demino)
  - [Demino Interface](#demino-interface)
  - [DeminoContext](#deminocontext)
  - [DeminoHandler](#deminohandler)
  - [DeminoOptions](#deminooptions)
  - [DeminoLogger](#deminologger)
  - [createResponseFrom()](#createresponsefrom)
  - [supportedMethods](#supportedmethods)
  - [CONTENT_TYPE](#content_type)
- [Routers](#routers)
  - [DeminoRouter (Abstract)](#deminorouter-abstract)
  - [DeminoSimpleRouter](#deminosimplerouter)
  - [DeminoUrlPatternRouter](#deminourlpatternrouter)
  - [DeminoFixedRouter](#deminofixedrouter)
  - [DeminoRegexRouter](#deminoregexrouter)
- [Middlewares](#middlewares)
  - [cors()](#cors)
  - [cookies()](#cookies)
  - [rateLimit()](#ratelimit)
  - [withETag()](#withetag)
  - [redirect()](#redirect)
  - [trailingSlash()](#trailingslash)
  - [proxy()](#proxy)
- [Composition & File-Based Routing](#composition--file-based-routing)
  - [deminoCompose()](#deminocompose)
  - [deminoFileBased()](#deminofilebased)
  - [routesCompare()](#routescompare)
- [Utilities](#utilities)
  - [TokenBucket](#tokenbucket)
  - [parseCookies()](#parsecookies)
  - [serializeCookie()](#serializecookie)
  - [sleep()](#sleep)
  - [withTimeout()](#withtimeout)
  - [isFn()](#isfn)
  - [isPlainObject()](#isplainobject)
  - [isValidDate()](#isvaliddate)

---

## Core

### demino()

Creates a new Demino application instance.

```ts
function demino(
  mountPath?: string,
  middleware?: DeminoHandler | DeminoHandler[],
  options?: DeminoOptions,
  appLocals?: DeminoAppLocals
): Demino
```

**Parameters:**
- `mountPath` - Base path for all routes (default: `""`). Must start with `/` if not empty.
- `middleware` - Global middleware(s) to run on every request
- `options` - Application configuration
- `appLocals` - Application-wide data accessible via `ctx.appLocals`

**Returns:** Demino application instance (also a valid `Deno.ServeHandler`)

**Example:**
```ts
const app = demino();
app.get("/", () => "Hello World");
Deno.serve(app);

// With mount path and middleware
const api = demino("/api", [authMiddleware]);
api.get("/users", getUsers);
```

---

### Demino Interface

The main application interface. Extends `Deno.ServeHandler`.

**Route Methods:**
```ts
app.get(route, ...handlers): Demino
app.post(route, ...handlers): Demino
app.put(route, ...handlers): Demino
app.patch(route, ...handlers): Demino
app.delete(route, ...handlers): Demino
app.head(route, ...handlers): Demino
app.options(route, ...handlers): Demino
app.connect(route, ...handlers): Demino
app.trace(route, ...handlers): Demino
app.all(route, ...handlers): Demino  // Matches all methods
```

**Other Methods:**

| Method | Description |
|--------|-------------|
| `use(...args)` | Register global or route-specific middlewares |
| `error(handler)` | Set custom error handler |
| `static(route, fsRoot, options?)` | Serve static files |
| `logger(logger)` | Set/unset application logger |
| `mountPath()` | Get the mount path |
| `info()` | Get debug info about routes |
| `getOptions()` | Get constructor options |
| `locals` | Application-wide locals object |

**Middleware Registration:**
```ts
app.use(mw);                    // App-global
app.use("/route", mw);          // Route-global (all methods)
app.get("/route", mw, handler); // Route-method specific
```

---

### DeminoContext

Request-scoped context object passed to every handler.

```ts
interface DeminoContext {
  params: Record<string, string>;  // Route params (readonly)
  locals: Record<string, any>;     // Request-scoped data store
  headers: Headers;                // Response headers to set
  status: number;                  // Response status (default: 200)
  route: string;                   // Matched route pattern
  ip: string;                      // Client IP address
  error: any;                      // Error (in error handlers)
  appLocals: DeminoAppLocals;      // App-wide persistent data
  getLogger(): DeminoLogger | null; // Get logger instance
  __start: Date;                   // Request start timestamp
}
```

**Example:**
```ts
app.get("/users/[id]", (req, info, ctx) => {
  const userId = ctx.params.id;
  ctx.headers.set("X-Custom", "value");
  ctx.status = 200;
  return { userId };
});
```

---

### DeminoHandler

Function signature for route handlers and middlewares.

```ts
type DeminoHandler = (
  req: Request,
  info: Deno.ServeHandlerInfo,
  ctx: DeminoContext
) => any | Promise<any>
```

**Return Value Handling:**
- `undefined` → 204 No Content
- Plain object/array/null/toJSON → JSON stringified
- `Response` → Passed through directly
- `Error` → Error response generated
- Anything else → `toString()` as text/html

---

### DeminoOptions

Configuration options for creating a Demino app.

```ts
interface DeminoOptions {
  routerFactory?: () => DeminoRouter;  // Custom router factory
  noXPoweredBy?: boolean;              // Disable X-Powered-By header
  noXResponseTime?: boolean;           // Disable X-Response-Time header
  verbose?: boolean;                   // Enable verbose logging
  logger?: DeminoLogger | null;        // Application logger
  errorHandler?: DeminoHandler;        // Custom error handler
}
```

---

### DeminoLogger

Logger interface for Demino applications.

```ts
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

---

### createResponseFrom()

Creates a Response from various body types.

```ts
function createResponseFrom(
  req: Request,
  body: any,
  headers?: Headers,
  status?: number
): Response
```

**Conversion Rules:**
- `undefined` → 204 No Content
- Plain object/array/null/toJSON → JSON with `application/json`
- Everything else → toString() with `text/html`
- HEAD requests → Empty body

---

### supportedMethods

Array of supported HTTP methods.

```ts
const supportedMethods: DeminoMethod[] = [
  "CONNECT", "DELETE", "GET", "HEAD", "OPTIONS",
  "PATCH", "POST", "PUT", "TRACE"
]
```

---

### CONTENT_TYPE

Common content-type header values.

```ts
const CONTENT_TYPE = {
  JSON: "application/json",
  TEXT: "text/plain; charset=utf-8",
  HTML: "text/html; charset=utf-8"
}
```

---

## Routers

### DeminoRouter (Abstract)

Base class for custom routers.

```ts
abstract class DeminoRouter {
  abstract on(route: string, callback: DeminoRouterOnMatch): void;
  abstract exec(pathname: string): DeminoRouterOnMatchResult | null;
  assertIsValid(route: string): void;
  info(): string[];
}
```

---

### DeminoSimpleRouter

Default router using [simple-router](https://github.com/marianmeres/simple-router).

**Route Syntax:** Uses bracket notation for parameters.
```ts
app.get("/users/[userId]/posts/[postId]", handler);
// ctx.params = { userId: "123", postId: "456" }
```

---

### DeminoUrlPatternRouter

Router using the [URL Pattern API](https://developer.mozilla.org/en-US/docs/Web/API/URL_Pattern_API).

```ts
const app = demino("", [], {
  routerFactory: () => new DeminoUrlPatternRouter()
});
app.get("/users/:id", handler);  // ctx.params = { id: "123" }
```

---

### DeminoFixedRouter

Simple string comparison router (no parameter extraction).

```ts
const app = demino("", [], {
  routerFactory: () => new DeminoFixedRouter()
});
app.get("/exact/path", handler);
```

---

### DeminoRegexRouter

Regex-based router with named groups for parameters.

```ts
const app = demino("", [], {
  routerFactory: () => new DeminoRegexRouter()
});
app.get("^/(?<year>\\d{4})$", handler);
// ctx.params = { year: "2024" }
```

---

## Middlewares

### cors()

Creates CORS middleware.

```ts
function cors(options?: Partial<CorsOptions>): DeminoHandler

interface CorsOptions {
  allowOrigin: string | string[] | ((origin, headers) => string);
  allowMethods: string | string[] | ((origin, headers) => string);
  allowHeaders: string | string[] | ((origin, headers) => string);
  allowCredentials: boolean | ((origin, headers) => boolean);
  maxAge: number | ((origin, headers) => number);
}
```

**Defaults:**
- `allowOrigin`: `"*"`
- `allowMethods`: `"GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS"`
- `allowHeaders`: `"Content-Type,Authorization"`
- `allowCredentials`: `true`
- `maxAge`: `86400` (24 hours)

**Example:**
```ts
app.use(cors({ allowOrigin: ["https://example.com"] }));
app.options("*", cors());  // Handle preflight
```

---

### cookies()

Creates cookie parsing and management middleware.

```ts
function cookies(defaults?: CookieOptions): DeminoHandler
```

**Adds to `ctx.locals`:**
- `cookies` - Parsed request cookies
- `setCookie(name, value, options?)` - Set response cookie
- `deleteCookie(name, options?)` - Delete cookie

**Example:**
```ts
app.use(cookies({ httpOnly: true, secure: true }));

app.get("/", (req, info, ctx) => {
  const session = ctx.locals.cookies.session;
  ctx.locals.setCookie("theme", "dark", { maxAge: 3600 });
  ctx.locals.deleteCookie("old");
});
```

---

### rateLimit()

Creates token bucket rate limiting middleware.

```ts
function rateLimit(
  getClientId: (req, info, ctx) => unknown,
  options?: Partial<RateLimitOptions>
): DeminoHandler

interface RateLimitOptions {
  maxSize: number;              // Burst capacity (default: 20)
  refillSizePerSecond: number;  // Sustained rate (default: 10)
  cleanupProbability: number;   // GC frequency 0-1 (default: 0.001)
  getConsumeSize: (req, info, ctx) => number;  // Token cost per request
}
```

**Example:**
```ts
app.use("/api", rateLimit(
  (req) => req.headers.get("Authorization"),
  { maxSize: 100, refillSizePerSecond: 50 }
));
```

---

### withETag()

Wraps a handler to add ETag support and 304 responses.

```ts
function withETag(
  handler: DeminoHandler,
  options?: { weak?: boolean }
): DeminoHandler
```

**Example:**
```ts
app.get("/data", withETag(async () => {
  return await fetchData();
}));
// First request: 200 + ETag header
// Subsequent with If-None-Match: 304 Not Modified
```

---

### redirect()

Creates a redirect middleware.

```ts
function redirect(
  url: string | URL,
  status?: 301 | 302 | 303 | 307 | 308
): DeminoHandler
```

**Example:**
```ts
app.use("/old", redirect("/new", 301));
app.use("/external", redirect("https://example.com"));
```

---

### trailingSlash()

Enforces trailing slash policy with 301 redirects.

```ts
function trailingSlash(
  flag: boolean,
  options?: { logger?: CallableFunction }
): DeminoHandler
```

**Example:**
```ts
app.use(trailingSlash(true));   // /foo -> /foo/
app.use(trailingSlash(false));  // /foo/ -> /foo
```

---

### proxy()

Creates a request proxy middleware.

```ts
function proxy(
  target: string | ((req, ctx) => string),
  options?: Partial<ProxyOptions>
): DeminoHandler

interface ProxyOptions {
  timeout: number;                    // Default: 60000
  preventSSRF: boolean;               // Block private IPs
  allowedHosts: string[];             // Host whitelist (supports wildcards)
  headers: Record<string, string>;    // Custom headers
  transformRequestHeaders: (headers, req, ctx) => Headers;
  transformResponseHeaders: (headers, resp) => Headers;
  transformResponseBody: (body, resp) => BodyInit | null;
  cache: RequestCache;                // Default: "no-store"
  onError: (error, req, ctx) => Response;
  removeRequestHeaders: string[];
  removeResponseHeaders: string[];
}
```

**Example:**
```ts
// Wildcard path proxying
app.get("/api/*", proxy("https://backend.example.com/*"));

// Dynamic target
app.get("/search/[q]", proxy((req, ctx) =>
  `https://api.example.com/search?q=${ctx.params.q}`
));

// With SSRF protection
app.get("/fetch/*", proxy("https://api.example.com/*", {
  preventSSRF: true,
  allowedHosts: ["api.example.com"]
}));
```

---

## Composition & File-Based Routing

### deminoCompose()

Composes multiple Demino apps into a single handler.

```ts
function deminoCompose(
  apps: Demino[],
  notFoundHandler?: (req, info) => Response
): Deno.ServeHandler
```

**Example:**
```ts
const app = demino();
const api = demino("/api");
const admin = demino("/admin");

Deno.serve(deminoCompose([app, api, admin]));
```

---

### deminoFileBased()

Enables directory-based routing.

```ts
function deminoFileBased(
  app: Demino,
  rootDirs: string | string[],
  options?: DeminoFileBasedOptions
): Promise<Demino>

interface DeminoFileBasedOptions {
  verbose?: boolean;
  logger?: DeminoLogger | null;
  doImport?: (modulePath: string) => Promise<any>;
}
```

**Directory Structure:**
```
routes/
├── _middleware.ts       # export default [mw1, mw2]
├── index.ts             # export function GET() {...}
└── users/
    ├── [userId]/
    │   └── index.ts     # export function GET() {...}
    └── index.ts
```

**Example:**
```ts
const app = demino();
await deminoFileBased(app, "./routes");
Deno.serve(app);
```

---

### routesCompare()

Comparator for sorting routes by specificity.

```ts
function routesCompare(a: string, b: string): number
```

Sorts deeper routes first, then static before dynamic.

---

## Utilities

### TokenBucket

Rate limiting using token bucket algorithm.

```ts
class TokenBucket {
  constructor(maxSize: number, refillPerSecond: number, logger?: DeminoLogger);
  refill(): TokenBucket;
  consume(quantity?: number): boolean;
  get size(): number;
}
```

**Example:**
```ts
const bucket = new TokenBucket(20, 10);  // 20 burst, 10/sec sustained

if (bucket.consume()) {
  // Request allowed
} else {
  // Rate limited
}
```

---

### parseCookies()

Parses Cookie header into key-value pairs.

```ts
function parseCookies(cookieHeader: string | null): Record<string, string>
```

---

### serializeCookie()

Serializes a cookie with options.

```ts
function serializeCookie(
  name: string,
  value: string,
  options?: CookieOptions
): string

interface CookieOptions {
  maxAge?: number;
  expires?: Date;
  path?: string;
  domain?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}
```

---

### sleep()

Promise-based delay utility.

```ts
function sleep(
  timeout: number,
  __timeout_ref__?: { id: number }
): Promise<void>
```

---

### withTimeout()

Wraps a function with timeout enforcement.

```ts
function withTimeout<T>(
  fn: CallableFunction,
  timeout?: number,
  errMessage?: string
): (...args: any[]) => Promise<T>

class TimeoutError extends Error {}
```

---

### isFn()

Type guard for functions.

```ts
function isFn(v: any): v is CallableFunction
```

---

### isPlainObject()

Type guard for plain objects.

```ts
function isPlainObject(v: any): v is Record<string, unknown>
```

---

### isValidDate()

Type guard for valid Date objects.

```ts
function isValidDate(v: any): v is Date
```
