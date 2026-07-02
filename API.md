# Demino API Reference

Complete API documentation for `@marianmeres/demino`.

## Table of Contents

- [Core](#core)
  - [demino()](#demino)
  - [Demino Interface](#demino-interface)
  - [DeminoContext](#deminocontext)
  - [DeminoHandler](#deminohandler)
  - [DeminoRouteInfo](#deminorouteinfo)
  - [DeminoOptions](#deminooptions)
  - [DeminoLogger](#deminologger)
  - [createResponseFrom()](#createresponsefrom)
  - [withMeta()](#withmeta)
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
  - [authz()](#authz)
  - [withPermission()](#withpermission)
  - [withPublic()](#withpublic)
  - [getSubject()](#getsubject)
  - [createRouteResolver()](#createrouteresolver)
  - [permissionMatrix()](#permissionmatrix)
  - [assertCovered()](#assertcovered)
  - [AuthzDecl](#authzdecl)
  - [AuthzMatrixRow](#authzmatrixrow)
  - [AUTHZ_META_KEY](#authz_meta_key)
- [Composition & File-Based Routing](#composition--file-based-routing)
  - [deminoCompose()](#deminocompose)
  - [deminoFileBased()](#deminofilebased)
  - [routesCompare()](#routescompare)
- [Utilities](#utilities)
  - [logListenInfo()](#loglisteninfo)
  - [createDeminoClog()](#createdeminoclog)
  - [createDeminoClogFrom()](#createdeminoclogfrom)
  - [TokenBucket](#tokenbucket)
  - [parseCookies()](#parsecookies)
  - [serializeCookie()](#serializecookie)
  - [sleep()](#sleep)
  - [withTimeout()](#withtimeout)
  - [isFn()](#isfn)
  - [isPlainObject()](#isplainobject)
  - [isValidDate()](#isvaliddate)
- [Constants](#constants)
  - [DEMINO_SORT](#demino_sort)

---

## Core

### demino()

Creates a new Demino application instance.

```ts
function demino(
	mountPath?: string,
	middleware?: DeminoHandler | DeminoHandler[],
	options?: DeminoOptions,
	appLocals?: DeminoAppLocals,
): Demino;
```

**Parameters:**

- `mountPath` - Base path for all routes (default: `""`). Must start with `/` if not
  empty.
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

| Method                            | Description                                   |
| --------------------------------- | --------------------------------------------- |
| `use(...args)`                    | Register global or route-specific middlewares |
| `error(handler)`                  | Set custom error handler                      |
| `static(route, fsRoot, options?)` | Serve static files                            |
| `logger(logger)`                  | Set/unset application logger                  |
| `mountPath()`                     | Get the mount path                            |
| `info()`                          | Get debug info about routes                   |
| `routes()`                        | Enumerate registered routes + meta (see below)|
| `getOptions()`                    | Get constructor options                       |
| `locals`                          | Application-wide locals object                |

**`routes(): DeminoRouteInfo[]`** — enumerates every registered `(method, route)`
together with its static `meta`, mirroring the dispatcher match-set (the `ALL`
router, catch-alls, and auto-HEAD via its GET registration). The read-side
companion to [`ctx.routeMeta`](#deminocontext), for build-time introspection and
audits (permission coverage, OpenAPI, sitemaps, cache policy, …). Handlers
without metadata report `meta: {}` (e.g. `app.static`). See
[`DeminoRouteInfo`](#deminorouteinfo).

**Middleware Registration:**

```ts
app.use(mw); // App-global
app.use("/route", mw); // Route-global (all methods)
app.get("/route", mw, handler); // Route-method specific
```

---

### DeminoContext

Request-scoped context object passed to every handler.

```ts
interface DeminoContext {
	readonly url: URL; // Effective request URL (proxy-aware)
	params: Record<string, string>; // Route params (readonly)
	locals: Record<string, any>; // Request-scoped data store
	routeMeta: Readonly<Record<string, unknown>>; // Static handler meta (frozen)
	headers: Headers; // Response headers to set
	status: number; // Response status (default: 200)
	route: string; // Matched route pattern
	ip: string; // Client IP address
	error: any; // Error (in error handlers)
	appLocals: DeminoAppLocals; // App-wide persistent data
	getLogger(): DeminoLogger | null; // Get logger instance
	__start: Date; // Request start timestamp
}
```

**`url`** — the effective request `URL`. Prefer it over `new URL(req.url)` whenever
you need the request's scheme/host/origin (absolute self-links, absolute redirects).
By default `ctx.url` equals `new URL(req.url)`; when the app sets
[`trustProxy`](#deminooptions), it is rebuilt from the reverse proxy's
`X-Forwarded-Proto`/`-Host`/`-Port` so it reflects the client-facing URL instead of
the internal proxy→app hop. Always defined. Routing is unaffected — Demino always
dispatches on `url.pathname`, which `trustProxy` never rewrites.

**`routeMeta`** — static metadata declared on the matched route handler (via
`handler.meta` or [`withMeta()`](#withmeta)). Stamped onto the context BEFORE any
middleware runs, so even global `app.use(...)` middleware can read it. Frozen;
defaults to `{}`; cached per `(method, route)`. Auto-HEAD inherits the GET
handler's meta. A generic primitive — useful for auth, rate-limit tiers, cache
policy, audit tags, telemetry, OpenAPI, etc. Its read-side companion is
[`app.routes()`](#demino-interface).

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
	ctx: DeminoContext,
) => any | Promise<any>;
```

**Return Value Handling:**

- `undefined` → 204 No Content
- Plain object/array/null/toJSON → JSON stringified
- `Response` → Passed through directly
- `Error` → Error response generated
- Anything else → `toString()` as text/html

**Optional properties:**

- `handler.meta?: Record<string, unknown>` — static metadata for the route,
  surfaced (frozen) as [`ctx.routeMeta`](#deminocontext) before any middleware
  runs. Merge onto it with [`withMeta()`](#withmeta).
- `handler.__midwarePreExecuteSortOrder?: number` — middleware execution order
  (ascending; lower runs first). See [`DEMINO_SORT`](#demino_sort).

---

### DeminoRouteInfo

One entry returned by [`app.routes()`](#demino-interface): a registered
`(method, route)` pair and the static metadata declared on its final handler.

```ts
type DeminoRouteInfo = {
	method: DeminoMethod | "ALL";
	route: string;
	meta: Readonly<Record<string, unknown>>;
};
```

Auto-HEAD is reported via its GET registration; handlers without metadata report
`meta: {}`.

---

### DeminoOptions

Configuration options for creating a Demino app.

```ts
interface DeminoOptions {
	routerFactory?: () => DeminoRouter; // Custom router factory
	noXPoweredBy?: boolean; // Disable X-Powered-By header
	noXResponseTime?: boolean; // Disable X-Response-Time header
	verbose?: boolean; // Enable verbose logging
	logger?: DeminoLogger | null; // Application logger
	errorHandler?: DeminoHandler; // Custom error handler
	trustProxy?: boolean | { allowedHosts?: string[] }; // Proxy-aware ctx.url (default OFF)
}
```

**`trustProxy`** (default OFF) — controls how [`ctx.url`](#deminocontext) is built from
reverse-proxy forwarding headers. Forwarded headers are client-spoofable unless the
origin is locked to the trusted proxy, so this is opt-in.

- `false`/`undefined` — `ctx.url === new URL(req.url)`; forwarding headers ignored.
- `true` — trust `X-Forwarded-Proto` only (`http|https`). The host is **not** reflected.
- `{ allowedHosts }` — additionally trust `X-Forwarded-Host` (and `X-Forwarded-Port`),
  but only when the forwarded host passes `isHostAllowed` (exact or `*.domain`). A
  non-matching forwarded host is dropped in favor of the request host. An empty/omitted
  `allowedHosts` trusts no forwarded host. **Recommended production form.**

Only the left-most (immediate-hop) token of each header is read, so the single trusted
proxy in front must be configured to overwrite (not append) these headers (nginx's
default). The internal origin port never leaks into an absolute self-URL. Note:
[`ctx.ip`](#deminocontext) trusts `X-Forwarded-For` **ungated** and is intentionally
not routed through this flag.

```ts
const app = demino("", [], {
	trustProxy: { allowedHosts: ["example.com", "*.example.com"] },
});
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
	status?: number,
): Response;
```

**Conversion Rules:**

- `undefined` → 204 No Content
- Plain object/array/null/toJSON → JSON with `application/json`
- Everything else → toString() with `text/html`
- HEAD requests → Empty body

---

### withMeta()

Merges static metadata onto a handler's `.meta` and returns the same handler (so
it can wrap inline at registration). The merged object is surfaced (frozen) as
[`ctx.routeMeta`](#deminocontext) before any middleware runs.

```ts
function withMeta<H extends DeminoHandler>(
	meta: Record<string, unknown>,
	handler: H,
): H;
```

**Parameters:**

- `meta` (`Record<string, unknown>`) — metadata to merge onto `handler.meta`.
- `handler` (`H extends DeminoHandler`) — the handler to decorate (mutated and
  returned).

**Returns:** `H` — the same handler instance.

**Example:**

```ts
app.get(
	"/invoices/[id]",
	withMeta({ permission: "invoice:read" }, (req, info, ctx) => {
		// a global app.use(...) middleware can already read ctx.routeMeta.permission
		return { id: ctx.params.id };
	}),
);
```

---

### supportedMethods

Array of supported HTTP methods.

```ts
const supportedMethods: DeminoMethod[] = [
	"CONNECT",
	"DELETE",
	"GET",
	"HEAD",
	"OPTIONS",
	"PATCH",
	"POST",
	"PUT",
	"TRACE",
];
```

---

### CONTENT_TYPE

Common content-type header values.

```ts
const CONTENT_TYPE = {
	JSON: "application/json",
	TEXT: "text/plain; charset=utf-8",
	HTML: "text/html; charset=utf-8",
};
```

---

## Routers

### DeminoRouter (Abstract)

Base class for custom routers.

```ts
abstract class DeminoRouter {
	abstract on(route: string, callback: DeminoRouterOnMatch): void;
	// `skipCatchAll` suppresses a deferred internal catch-all (e.g. the `*` route
	// in DeminoSimpleRouter) so only real routes can match; ignored by routers
	// without a deferred catch-all.
	abstract exec(
		pathname: string,
		options?: { skipCatchAll?: boolean },
	): DeminoRouterOnMatchResult | null;
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

Router using the
[URL Pattern API](https://developer.mozilla.org/en-US/docs/Web/API/URL_Pattern_API).

```ts
const app = demino("", [], {
	routerFactory: () => new DeminoUrlPatternRouter(),
});
app.get("/users/:id", handler); // ctx.params = { id: "123" }
```

---

### DeminoFixedRouter

Simple string comparison router (no parameter extraction).

```ts
const app = demino("", [], {
	routerFactory: () => new DeminoFixedRouter(),
});
app.get("/exact/path", handler);
```

---

### DeminoRegexRouter

Regex-based router with named groups for parameters.

```ts
const app = demino("", [], {
	routerFactory: () => new DeminoRegexRouter(),
});
app.get("^/(?<year>\\d{4})$", handler);
// ctx.params = { year: "2024" }
```

---

## Middlewares

### cors()

Creates CORS middleware.

```ts
function cors(options?: Partial<CorsOptions>): DeminoHandler;

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
- `allowCredentials`: `false` _(changed from `true` in 1.7.0 — see BC notes in README)_
- `maxAge`: `86400` (24 hours)

**Constraints:**

- `cors({ allowOrigin: "*", allowCredentials: true })` throws `TypeError` (CORS spec
  forbids the combination). To allow credentials, supply an explicit allowlist or function
  returning the matched origin.
- If a _dynamic_ `allowOrigin` resolves to `"*"` while `allowCredentials` is `true`, the
  middleware refuses to set the response headers and logs a warning.

**Example:**

```ts
// Public read-only API: wildcard origin, no credentials (default)
app.use(cors());

// Credentialed API: explicit allowlist required
app.use(cors({
	allowOrigin: ["https://app.example.com"],
	allowCredentials: true,
}));

app.options("*", cors()); // Handle preflight
```

---

### cookies()

Creates cookie parsing and management middleware.

```ts
function cookies(defaults?: CookieOptions): DeminoHandler;
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
	options?: Partial<RateLimitOptions>,
): DeminoHandler;

interface RateLimitOptions {
	maxSize: number; // Burst capacity (default: 20)
	refillSizePerSecond: number; // Sustained rate (default: 10)
	cleanupProbability: number; // GC frequency 0-1 (default: 0.001)
	getConsumeSize: (req, info, ctx) => number; // Token cost per request
}
```

**Example:**

```ts
app.use(
	"/api",
	rateLimit(
		(req) => req.headers.get("Authorization"),
		{ maxSize: 100, refillSizePerSecond: 50 },
	),
);
```

---

### withETag()

Wraps a handler to add ETag support and 304 responses.

```ts
function withETag(
	handler: DeminoHandler,
	options?: ETagOptions,
): DeminoHandler;

interface ETagOptions {
	weak?: boolean; // generate W/"..." instead of "..." (default: false)
	maxSizeBytes?: number; // skip hashing if body is larger (default: 1_048_576;
	// pass 0 or Infinity to disable the cap)
}
```

The middleware buffers the entire response body in memory to compute SHA-1, so by default
responses larger than 1 MiB are returned unchanged with no ETag header. Lift the cap
explicitly when you accept the memory cost.

**Example:**

```ts
app.get(
	"/data",
	withETag(async () => {
		return await fetchData();
	}),
);
// First request: 200 + ETag header
// Subsequent with If-None-Match: 304 Not Modified
```

---

### redirect()

Creates a redirect middleware.

```ts
function redirect(
	url: string | URL,
	status?: 301 | 302 | 303 | 307 | 308,
): DeminoHandler;
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
	options?: { logger?: CallableFunction },
): DeminoHandler;
```

**Example:**

```ts
app.use(trailingSlash(true)); // /foo -> /foo/
app.use(trailingSlash(false)); // /foo/ -> /foo
```

---

### proxy()

Creates a request proxy middleware.

```ts
function proxy(
	target: string | ((req, ctx) => string),
	options?: Partial<ProxyOptions>,
): DeminoHandler;

interface ProxyOptions {
	timeout: number; // Default: 60000
	maxRedirects: number; // Default: 5. Upstream redirects to follow (each hop re-validated)
	preventSSRF: boolean; // Block private IPs (string-only check, no DNS)
	allowedHosts: string[]; // Host whitelist (supports wildcards)
	webSockets: boolean; // Default: true. Tunnel WebSocket upgrade requests
	headers: Record<string, string>; // Custom headers
	transformRequestHeaders: (headers, req, ctx) => Headers;
	transformResponseHeaders: (headers, resp) => Headers;
	transformResponseBody: (body, resp) => BodyInit | null;
	cache: RequestCache; // Default: "no-store"
	onError: (error, req, ctx) => Response;
	removeRequestHeaders: string[];
	removeResponseHeaders: string[];
}
```

**`preventSSRF` covers (since 1.7.0):**

- localhost (`localhost`, `*.localhost`, `127.0.0.0/8`)
- Unspecified `0.0.0.0` and `::`
- Private IPv4: `10/8`, `172.16/12`, `192.168/16`, `169.254/16` (link-local), `100.64/10`
  (CGNAT)
- Private IPv6: `::1`, `fe80::/10`, `fc00::/7`
- IPv4-mapped IPv6 in dotted and hex form (`::ffff:127.0.0.1`, `::ffff:7f00:1`) and NAT64
  (`64:ff9b::`). The hex form is what WHATWG URL normalization produces
  (`new URL("http://[::ffff:127.0.0.1]/").hostname` === `[::ffff:7f00:1]`).
- Bracketed IPv6 hostnames (`[::1]`)

**Redirect re-validation (since 1.17.0):** the proxy follows upstream redirects _manually_
(never `fetch`'s transparent `redirect: "follow"`) and re-applies the full self-proxy /
SSRF / `allowedHosts` policy to _every hop_, so a permitted upstream cannot 3xx the proxy
into an internal host. Bounded by `maxRedirects` (default 5); exceeding it errors (→ 500).
A body-preserving 307/308 whose one-shot request body cannot be replayed is returned to the
client unfollowed.

**Caveat:** `preventSSRF` is a _string-only_ check on the target hostname — DNS is not
resolved. A public hostname that resolves (or is DNS-rebound) to a private IP bypasses this
guard. For DNS-rebinding-resistant SSRF protection, resolve the hostname yourself and
re-check each address.

**WebSocket proxying (since 1.17.0):** enabled by default (`webSockets: false` to
disable). A well-formed WebSocket upgrade request (GET + `Upgrade: websocket` +
`Sec-WebSocket-Key` + version 13) is tunneled to the upstream; `http(s)` targets are
dialed as `ws(s)`. The upstream is dialed _first_ — the full target policy (self-proxy /
SSRF / `allowedHosts`) applies, request headers (cookies, authorization, custom `headers`,
`transformRequestHeaders`, `X-Forwarded-*`, hop-counter loop guard) are forwarded, and
subprotocols are negotiated end-to-end — and the client is upgraded only after the
upstream handshake succeeds, so a failed dial surfaces as a regular HTTP error (502
unreachable, 504 handshake timeout, or your `onError`), not a dropped socket. Close code +
reason propagate in both directions. `timeout` bounds only the upstream handshake, never
the tunnel lifetime. Not applicable to tunnels: `maxRedirects` (upstream WebSocket
redirects are not followed), `cache`, `transformResponseHeaders`,
`transformResponseBody` (the 101 response is runtime-generated). A malformed upgrade
request falls through to the regular HTTP proxy path.

**Example:**

```ts
// Wildcard path proxying
app.get("/api/*", proxy("https://backend.example.com/*"));

// WebSocket tunneling (enabled by default)
// ws://this-app/ws/chat -> wss://backend.example.com/ws/chat
app.get("/ws/*", proxy("https://backend.example.com/*"));

// Dynamic target
app.get(
	"/search/[q]",
	proxy((req, ctx) => `https://api.example.com/search?q=${ctx.params.q}`),
);

// With SSRF protection
app.get(
	"/fetch/*",
	proxy("https://api.example.com/*", {
		preventSSRF: true,
		allowedHosts: ["api.example.com"],
	}),
);
```

---

### authz()

Generic, policy-free authorization gate. Reads each route's declaration from
[`ctx.routeMeta`](#deminocontext) (key `"authz"`, set via
[`withPermission()`](#withpermission) / [`withPublic()`](#withpublic), or a
fallback `resolve`) and enforces it through your opaque `check` callback. Demino
keeps NO rbac/policy dependency — wire `@marianmeres/rbac` (or anything) inside
`check`.

Register it once, EARLY — right after any subject-resolving auth middleware. It
runs in normal registration order (it is NOT self-pinned to an early sort order),
so it composes with a preceding middleware that populates the subject.

```ts
function authz(options: AuthzOptions): DeminoHandler;

interface AuthzOptions {
	// REQUIRED. Opaque permission check; return true to allow. May be async.
	check: (
		subject: unknown,
		permission: string,
		ctx: DeminoContext,
	) => boolean | Promise<boolean>;
	// Resolve + store the subject when ctx.locals[subjectKey] is empty.
	resolveSubject?: (
		req: Request,
		info: Deno.ServeHandlerInfo,
		ctx: DeminoContext,
	) => unknown | Promise<unknown>;
	// Fallback declaration for routes with no static meta. See createRouteResolver().
	resolve?: (method: string, route: string) => AuthzDecl | null;
	subjectKey?: string; // ctx.locals slot for the subject. Default "subject".
	denyByDefault?: boolean; // Deny (403) undeclared routes. Default true.
	allowOptions?: boolean; // Let OPTIONS bypass the gate. Default true.
}
```

**Resolution order per request:**

1. `OPTIONS` → allow (when `allowOptions`).
2. Resolve subject via `resolveSubject` if the slot is empty (even for public
   routes, so downstream handlers see it).
3. No declaration anywhere → deny (403), unless `denyByDefault: false` (then pass
   through ungated).
4. `{ public: true }` → allow.
5. Permission required but no subject → 401.
6. Run `check` for each permission with `every` (default) or `some`.
7. All required pass → allow; otherwise → deny (403).

**Example:**

```ts
import { Rbac } from "@marianmeres/rbac"; // the APP imports rbac, not demino
import { authz, withPermission, withPublic } from "@marianmeres/demino/middleware";

const rbac = new Rbac(); // ...roles/groups/rules...

app.use(authz({
	resolveSubject: (req) => verifyJwt(req.headers.get("authorization")),
	check: (subject, permission) => rbac.can(subject as any, permission),
}));

app.get("/health", withPublic(() => "ok"));
app.get("/invoices/[id]", withPermission("invoice:read", (req, info, ctx) => {
	// reached only if check() returned true
	return { id: ctx.params.id };
}));
```

> All `authz` symbols are exported from both `@marianmeres/demino` and
> `@marianmeres/demino/middleware`.

---

### withPermission()

Declares the permission(s) a route requires, as static `authz` meta read by the
[`authz()`](#authz) gate. Sugar over [`withMeta()`](#withmeta).

```ts
function withPermission<H extends DeminoHandler>(
	permission: string | string[],
	handler: H,
	opts?: { mode?: "every" | "some" },
): H;
```

**Parameters:**

- `permission` (`string | string[]`) — required permission(s).
- `handler` (`H extends DeminoHandler`) — the handler to decorate (mutated and
  returned).
- `opts.mode` (`"every" | "some"`, optional) — how multiple permissions combine.
  Default: `"every"`.

**Returns:** `H` — the same handler.

**Example:**

```ts
app.get("/invoices/[id]", withPermission("invoice:read", handler));
app.post(
	"/invoices",
	withPermission(["invoice:create", "billing:write"], handler, { mode: "every" }),
);
```

---

### withPublic()

Declares a route public — the [`authz()`](#authz) gate allows it without a
subject or permission check. Sugar over [`withMeta()`](#withmeta).

```ts
function withPublic<H extends DeminoHandler>(handler: H): H;
```

**Returns:** `H` — the same handler.

**Example:**

```ts
app.get("/health", withPublic(() => "ok"));
```

---

### getSubject()

Typed accessor for the subject the [`authz()`](#authz) gate stored in
`ctx.locals`. Returns `null` if absent. Avoids a viral generic on
`DeminoContext`.

```ts
function getSubject<T>(ctx: DeminoContext, subjectKey?: string): T | null;
```

**Parameters:**

- `ctx` (`DeminoContext`) — the request context.
- `subjectKey` (`string`, optional) — the `ctx.locals` key to read. Default:
  `"subject"`.

**Example:**

```ts
app.get("/me", (req, info, ctx) => {
	const user = getSubject<MyUser>(ctx);
	return user ? `Hi ${user.name}` : "anon";
});
```

---

### createRouteResolver()

Builds a `(method, route) => AuthzDecl | null` resolver from a route-pattern map,
for use as [`AuthzOptions.resolve`](#authz) — centralizing policy in a route map
instead of decorating handlers. `*` matches a single path segment; `**` matches
the rest of the path. First match wins (array form preserves order; object form
uses key order). Because it keys only on `(method, route)`, it is replayable by
[`permissionMatrix()`](#permissionmatrix) at build time.

```ts
function createRouteResolver(
	map: Array<[string, AuthzDecl]> | Record<string, AuthzDecl>,
): (method: string, route: string) => AuthzDecl | null;
```

**Example:**

```ts
const resolve = createRouteResolver([
	["/health", { public: true }],
	["/api/*/me/**", { permission: "area.me:access" }],
	["/api/**", { permission: "api:access" }],
]);
app.use(authz({ check, resolve }));
```

---

### permissionMatrix()

Build-time authorization coverage report over [`app.routes()`](#demino-interface).
Each row states whether a registered route is `permission`-gated, `public`, or
`MISSING` a declaration, and whether the declaration came from `static` meta or
the `resolver`. Pair it with the SAME `resolve` you pass to [`authz()`](#authz)
so the report reflects what the gate would enforce.

```ts
function permissionMatrix(
	app: Demino,
	opts?: { resolve?: (method: string, route: string) => AuthzDecl | null },
): AuthzMatrixRow[];
```

**Example:**

```ts
console.table(permissionMatrix(app));
```

---

### assertCovered()

Asserts every matchable route has an explicit authorization declaration (static
or via `resolve`); throws listing any `MISSING` routes. This is the real
fail-closed guarantee — a runtime gate cannot cover 404/405 or static catch-alls,
so coverage is asserted at build time / in CI.

```ts
function assertCovered(
	app: Demino,
	opts?: { resolve?: (method: string, route: string) => AuthzDecl | null },
): void;
```

**Throws:** if any registered route lacks a declaration.

**Example:**

```ts
// in a build-time check or CI test
assertCovered(app); // throws listing any MISSING routes
```

---

### AuthzDecl

A per-route authorization declaration: either explicitly public, or requiring
one or more (opaque) permissions.

```ts
type AuthzDecl =
	| { public: true }
	| { permission: string | string[]; mode?: "every" | "some" };
```

---

### AuthzMatrixRow

One row in the coverage matrix returned by
[`permissionMatrix()`](#permissionmatrix).

```ts
interface AuthzMatrixRow {
	method: DeminoMethod | "ALL";
	route: string;
	declaration: "permission" | "public" | "MISSING";
	permission?: string | string[]; // present when declaration === "permission"
	source: "static" | "resolver";
}
```

---

### AUTHZ_META_KEY

The reserved [`ctx.routeMeta`](#deminocontext) key under which the authz
declaration is stored. Intentionally a plain string (not a Symbol) so
[`permissionMatrix()`](#permissionmatrix) can serialize a coverage report to JSON.

```ts
const AUTHZ_META_KEY = "authz";
```

---

## Composition & File-Based Routing

### deminoCompose()

Composes multiple Demino apps into a single handler.

```ts
function deminoCompose(
	apps: Demino[],
	notFoundHandler?: (req, info) => Response,
): Deno.ServeHandler;
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
	options?: DeminoFileBasedOptions,
): Promise<Demino>;

interface DeminoFileBasedOptions {
	verbose?: boolean;
	logger?: DeminoLogger | null;
	doImport?: (modulePath: string) => Promise<any>;
	ignoreMissingRootDir?: boolean;
}
```

**Parameters:**

- `app` (`Demino`) — Application instance to register routes on.
- `rootDirs` (`string | string[]`) — Directory (or directories) to scan for routes.
- `options` (`DeminoFileBasedOptions`, optional)
  - `verbose` (`boolean`) — Log discovered routes via `logger`. Default: `true`.
  - `logger` (`DeminoLogger | null`) — Custom logger. Default: `console`.
  - `doImport` (`(modulePath: string) => Promise<any>`) — Override the default
    `file://` dynamic importer. Useful for bundling, mocking, or custom module
    resolution.
  - `ignoreMissingRootDir` (`boolean`) — Skip a non-existent root directory (with a
    `logger.warn`) instead of throwing. Default: `false`. See **Missing root
    directory** below.

**Returns:** `Promise<Demino>` — The same `app` instance (for chaining).

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

**Missing root directory:**

By default a missing root directory is a hard error — it throws a `Deno.errors.NotFound`
(carrying `code: "ENOENT"`). At boot time an absent routes directory almost always means a
typo or a wrong working directory, and silently producing a zero-route app is a worse
failure to debug. Match on `e instanceof Deno.errors.NotFound` or `e.code === "ENOENT"`
(not the error `name`) when catching it.

Set `ignoreMissingRootDir: true` for the legitimate "optional dir" case (e.g. a core
dir plus a conditionally-present plugins/overrides dir) — missing roots are then
skipped with a `logger.warn`:

```ts
await deminoFileBased(app, ["./routes", "./plugins"], {
	ignoreMissingRootDir: true, // absent dirs are skipped, not fatal
});
```

A root that exists but is **not** a directory always throws a `TypeError`, regardless of
`ignoreMissingRootDir`.

---

### routesCompare()

Comparator for sorting routes by specificity.

```ts
function routesCompare(a: string, b: string): number;
```

Sorts deeper routes first, then static before dynamic.

---

## Utilities

### logListenInfo()

Console logging callback for `Deno.serve()`'s `onListen` option. Prints the server's
listening URL(s) with color formatting. When bound to `0.0.0.0`, displays both `localhost`
and all detected IPv4 network addresses.

```ts
function logListenInfo(localAddr: Deno.NetAddr): void;
```

**Example:**

```ts
import { deminoCompose, logListenInfo } from "@marianmeres/demino";

Deno.serve(
	{
		port: parseInt(Deno.env.get("SERVER_PORT") || "") || undefined,
		hostname: Deno.env.get("SERVER_HOST") || undefined,
		onListen: logListenInfo,
	},
	deminoCompose([app]),
);
```

---

### createDeminoClog()

Creates a `DeminoLogger` instance using `@marianmeres/clog`, with all standard logging
methods plus access log support.

```ts
function createDeminoClog(
	namespace?: string,
	config?: ClogConfig,
): DeminoLogger;
```

**Parameters:**

- `namespace` (`string`) — Clog namespace prefix. Default: `"demino"`
- `config` (`ClogConfig`, optional) — Clog configuration options

**Example:**

```ts
import { createDeminoClog, demino } from "@marianmeres/demino";

const app = demino("", [], {
	logger: createDeminoClog("my-app"),
});
```

---

### createDeminoClogFrom()

Creates a `DeminoLogger` from an existing `Clog` instance.

```ts
function createDeminoClogFrom(clog: Clog): DeminoLogger;
```

**Example:**

```ts
import { createClog } from "@marianmeres/clog";
import { createDeminoClogFrom } from "@marianmeres/demino";

const myClog = createClog("my-app", { debug: true });
const app = demino("", [], {
	logger: createDeminoClogFrom(myClog),
});
```

---

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
const bucket = new TokenBucket(20, 10); // 20 burst, 10/sec sustained

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
function parseCookies(cookieHeader: string | null): Record<string, string>;
```

---

### serializeCookie()

Serializes a cookie with options.

```ts
function serializeCookie(
	name: string,
	value: string,
	options?: CookieOptions,
): string;

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
	__timeout_ref__?: { id: number },
): Promise<void>;
```

---

### withTimeout()

Wraps a function with timeout enforcement. The wrapped function is invoked with an
`AbortSignal` appended to its arguments, and that signal is aborted on timeout — so a
`fetch`-based wrappee can actually cancel its in-flight request.

```ts
function withTimeout<T>(
	fn: CallableFunction,
	timeout?: number, // ms; pass 0 to disable the timer (default: 1000)
	errMessage?: string,
): (...args: any[]) => Promise<T>;

class TimeoutError extends Error {}
```

**Example:**

```ts
const timedFetch = withTimeout(
	(url: string, signal?: AbortSignal) => fetch(url, { signal }),
	5_000,
);
await timedFetch("https://api.example.com/data"); // throws TimeoutError after 5s
```

> **BC (1.7.0):** the wrapped function now receives an extra trailing `AbortSignal`
> argument. Functions that ignore extra args are unaffected at runtime, but TypeScript may
> flag a signature mismatch — declare your function as `(...args, signal?: AbortSignal)`.

---

### isFn()

Type guard for functions.

```ts
function isFn(v: any): v is CallableFunction;
```

---

### isPlainObject()

Type guard for plain objects.

```ts
function isPlainObject(v: any): v is Record<string, unknown>;
```

---

### isValidDate()

Type guard for valid Date objects.

```ts
function isValidDate(v: any): v is Date;
```

---

## Constants

### DEMINO_SORT

Named reference points for `handler.__midwarePreExecuteSortOrder` (ascending —
lower runs first). Demino assigns `DEFAULT` to middleware and `HANDLER` to the
final handler. `PRE` is a published slot below `DEFAULT` for positioning a
middleware ahead of the normal chain without a magic number.

```ts
const DEMINO_SORT = {
	PRE: 100, // runs before normal middleware
	DEFAULT: 1_000, // default for middleware that don't set their own order
	HANDLER: Infinity, // the final route handler (runs last)
} as const;
```

**Example:**

```ts
const mw: DeminoHandler = (req, info, ctx) => {/* ... */};
mw.__midwarePreExecuteSortOrder = DEMINO_SORT.PRE; // runs before normal mws
app.use(mw);
```
