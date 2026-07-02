# @marianmeres/demino

[![JSR](https://jsr.io/badges/@marianmeres/demino)](https://jsr.io/@marianmeres/demino)

"Demino" (Deno minimal) - minimalistic web server framework built on top of the Deno's
built-in HTTP server, providing:

- **routing**,
- **middlewares support**,
- **error handling**,
- **logging**
- and a little more.

## Batteries are NOT included

The design goal of this project is to provide a thin and
[sweet](https://en.wikipedia.org/wiki/Syntactic_sugar) extensible layer on top of the
`Deno.serve` handler. Nothing more, nothing less. In other words, this is a building
blocks framework, not a full featured web server.

## Installation

```sh
deno add jsr:@marianmeres/demino
```

## API Documentation

For complete API reference, see [API.md](API.md).

## Basic usage

```ts
import { demino } from "@marianmeres/demino";

// create the Demino app instance
const app = demino();

// register method and route handlers...
app.get("/", () => "Hello, World!");

// serve (Demino app is a `Deno.serve` handler)
Deno.serve(app);
```

## Mount path

Every Demino app is created with a **route prefix** called the `mountPath`. The default
`mountPath` is an empty string. Every `route` is then joined as `mountPath + route`,
which - when joined - must begin with a `/`.

## Routing

Every incoming request in Demino app is handled based on its `pathname` which is matched
against the registered _routes_.

The actual route matching is handled by the router. By default, Demino uses
[simple-router](https://github.com/marianmeres/simple-router).

```typescript
// create a Demino with a `/api` mount path
const api = demino("/api");

// will handle `HTTP GET /api/users/123`
api.get("/users/[userId]", (req, info, ctx) => Users.find(ctx.params.userId));
```

Demino also comes with
[URL Pattern](https://developer.mozilla.org/en-US/docs/Web/API/URL_Pattern_API) based
router. Read more about it below.

### Catch-all (`*`) precedence

A `*` catch-all always resolves **globally last** - it only fires once nothing else
matched. The effective order is: real routes (any method) → catch-all routes. So a
catch-all never shadows a more specific route, regardless of the HTTP method it was
registered on:

```typescript
app.get("/", () => "home");
app.all("/files/*", () => "static");
app.get("*", () => {
	throw createHttpError(404);
}); // legacy fallback

// GET /files/logo.png -> "static"  (the .all() route wins over the GET catch-all)
// GET /              -> "home"
// GET /anything-else -> 404        (the catch-all fires only here)
```

> **Note (1.8.8):** Earlier versions let a method-specific catch-all (e.g. `app.get("*")`)
> shadow `app.all("/files/*")` and similar literal routes. Catch-alls are now consistently
> last. A `*` registered on any single method no longer turns an otherwise-unmatched
> `HEAD` request into a `405`.

## Middlewares and route handlers

The stuff happens in route handlers. Or in middlewares. Or in both. In fact, they are
technically the same thing - the route handler is just the final middleware in the
internal collection.

Having said that, they are still expected to behave a little differently. Middlewares
mainly _do_ something (eg validate), while route handlers mainly _return_ something (eg
html string or json objects).

As soon as any middleware decides to _return_ a thing, the middlewares execution chain is
terminated and a `Response` is sent immediately.

Unlike in `Deno.serve` handlers, the Demino route handlers are not required to return a
`Response` instance, it will be created automatically based on what they return:

- if the final returned value is `undefined` (no middleware returned a defined value),
  empty `204 No Content` response will be created,
- if any returned value is a plain object (or `null`, or `toJSON` aware) it will be
  `JSON.stringify`-ed and served as `application/json` content type,
- if any middleware threw (or returned) an `Error`, error response is generated,
- everything else is cast to string and served as `text/html`.

The automatic content type headers above are only set if none exist.

You can safely bypass this opinionated behavior by returning the `Response` instance
yourself.

```typescript
// conveniently return plain object and have it be converted 
// to a Response instance automatically
app.get("/json", () => ({ this: 'will', be: 'JSON', string: 'ified'}));

// or return any other type (the `toString` method, if available, will be invoked by js)
class MyRenderer {
    constructor(data) {...}
    toString() { return `...`; }
}
app.get('/templated', (r, i, c) => new MyRenderer(c.locals))

// or return the Response instance directly
app.get('/manual', () => new Response('This will be sent as is.'))
```

The middleware and/or route handler has the following signature (note that the arguments
are a subset of the normal `Deno.ServeHandler`, meaning that any valid `Deno.ServeHandler`
is a valid Demino app handler):

```typescript
function handler(req: Request, info: Deno.ServeHandlerInfo, context: DeminoContext): any;
```

Middlewares can be registered as:

- `app.use(middleware)` - globally per app (will be invoked for every method on every
  route),
- `app.use("/route", middleware)` - globally per route (will be invoked for every method
  on a given route),
- `app.get("/route", middleware, handler)` - locally for given method and route.

```typescript
app
	.use(someGlobal)
	.use("/secret", authCheck)
	.get("/secret", readSecret, handler);
```

## Context

Each middleware receives a `DeminoContext` as its last parameter which visibility and
lifetime is limited to the scope and lifetime of the request handler.

It consists of:

- `params` - the readonly router parsed params,
- `locals` - plain object, where each middleware can write and read arbitrary data.
- `status` - HTTP status number to be optionally used in the final response,
- `headers` - any headers to be optionally used in the final response,
- `error` - to be used in a custom error handler.
- `route` - currently matched route definition
- `routeMeta` - static metadata declared on the matched route handler (see below)
- `getLogger` - function to get the logger instance (if any) initially provided via
  `DeminoOptions` or later via `app.logger(...)` api

```typescript
const app = demino("/articles");

// example middleware loading article (from DB, let's say)...
app.use(async (req: Request, info: Deno.ServeHandlerInfo, ctx: DeminoContext) => {
	// eg any route which will have an `/[articleId]/` segment, we automatically read
	// article data (which also means, it will auto validate the parameter)
	if (ctx.params.articleId) {
		ctx.locals.article = await Article.find(ctx.params.articleId);
		if (!ctx.locals.article) {
			throw new ArticleNotFound(`Article ${ctx.params.articleId} not found`);
		}
	}
});

// ...and route handler acting as a pure renderer. This handler will not
// be reached if the article is not found
app.get("/[articleId]", (req, info, ctx) => render(ctx.locals.article));
```

### Static route metadata (`ctx.routeMeta` / `withMeta`)

A route handler can carry static, opaque metadata that Demino surfaces on `ctx.routeMeta`
**before any middleware runs** — so even the first global `app.use` middleware can read it
as plain data (no injector, no execution-order trick). It is frozen, defaults to `{}`, is
cached per `(method, route)`, and is inherited by auto-HEAD. This is generic
(auth/permission, rate limits, cache policy, audit tags, telemetry, OpenAPI…), not tied to
any one concern.

```typescript
import { demino, withMeta } from "@marianmeres/demino";

const app = demino();

// one global middleware reads the per-route declaration as data
app.use((req, info, ctx) => {
	const required = ctx.routeMeta.permission; // reliably present before this runs
	// ...gate on it, attach a rate limit, set a cache policy, etc.
});

app.get(
	"/invoices/[id]",
	withMeta({ permission: "invoice:read" }, (req, info, ctx) => {
		return { id: ctx.params.id };
	}),
);
```

You can also set `handler.meta = {...}` directly; `withMeta` just merges and returns the
same handler for ergonomic inline use.

### Route introspection (`app.routes()`)

`app.routes()` enumerates every registered `(method, route, meta)` — mirroring the
dispatcher match-set (ALL router, catch-alls, auto-HEAD). It is the read-side companion to
`routeMeta`, intended for build-time introspection and audits (permission coverage,
OpenAPI/sitemap generation, cache-policy checks):

```typescript
for (const { method, route, meta } of app.routes()) {
	// e.g. assert every route declares a permission, or build a permission matrix
}
```

### Middleware ordering (`DEMINO_SORT`)

Middleware order is controlled by `handler.__midwarePreExecuteSortOrder` (ascending; lower
runs first). The exported `DEMINO_SORT` constant publishes the reference points Demino
assigns by default — `PRE` (100), `DEFAULT` (1000), `HANDLER` (Infinity) — so a middleware
can position itself ahead of the normal chain deterministically:

```typescript
import { DEMINO_SORT } from "@marianmeres/demino";

const gate: DeminoHandler = (req, info, ctx) => {/* runs first */};
gate.__midwarePreExecuteSortOrder = DEMINO_SORT.PRE;
app.use(gate);
```

## Application Locals

Unlike `ctx.locals` which is request-scoped, `app.locals` provides application-wide shared
data accessible from any handler via `ctx.appLocals`.

```ts
const app = demino("", [], {}, { config: loadedConfig });

// Or set after creation
app.locals.db = databaseConnection;

// Access in handlers
app.get("/", (r, i, ctx) => {
	const config = ctx.appLocals.config;
	const db = ctx.appLocals.db;
	// ...
});
```

**Important:** Properties can be mutated (`app.locals.foo = "bar"`), but the object
reference cannot be reassigned (`app.locals = { ... }` will log a warning and be ignored).
This ensures handlers always reference the same object.

## Error handling

Errors are caught and passed to the error handler. The built-in error handler can be
replaced via the `app.error` method (eg `app.error(myErrorHandler)`):

```typescript
// example: customized json response error handler
app.error((req, info, ctx) => {
	ctx.status = ctx.error?.status || 500;
	return { ok: false, message: ctx.error.message };
});
```

By default, **server faults** (status `>= 500`) are logged via the application's
`logger.error(...)`. **Client errors** (`4xx`, including `404`s — and including a `*`
catch-all handler that _throws_ `404`) are intentionally **not** error-logged: they're
routine (stale/bad requests, scanners, auth rejections) and are already visible in the
access log, which carries the URL. The logged value is a structured object:

```ts
logger.error({
	status, // the response status (>= 500)
	method, // req.method
	url, // proxy-aware `ctx.url.href` (not the internal proxy→app hop)
	ip, // proxy-aware `ctx.ip` (gated by trustProxy)
	error, // the original throw, stringified to its stack
});
```

`error` is stringified on purpose: a bare `Error` serializes to `{}` under JSON loggers,
which would drop the very stack you're logging. To silence everything (including 5xx), use
`app.logger(null)`.

## Application log

Demino application logger has the following interface:

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

The Demino logger, if not provided, defaults to a console-backed adapter. You can provide
a custom logger:

- when creating the app via `DeminoOptions` (eg
  `demino("", [], { logger: myCustomLogger })`)
- or anytime later via `app.logger(logger: DeminoLogger)`

If you do not wish the default to be active, you must turn it off explicitly via
`app.logger(null)`.

The default adapter forwards `debug`/`log`/`warn`/`error` to the matching `console.*`
methods, and emits `access` to `console.log` prefixed with `[access]`. If you want a
different access log format, supply your own logger:

```ts
// example to log access to console as well
const app = demino("", [], {
	logger: { ...console, access: (data) => console.log(data) },
});
```

> **Note (1.7.0):** Prior versions cast `console` directly to `DeminoLogger` even though
> `console.access` doesn't exist, so access logs were silently dropped unless a custom
> logger was supplied. The default adapter introduced in 1.7.0 wires `access` to
> `console.log` so the default behavior matches the type.

For convenience, this package provides the `createDeminoClog` helper that creates a
complete logger with access logging using
[`@marianmeres/clog`](https://jsr.io/@marianmeres/clog):

```ts
import { createDeminoClog } from "@marianmeres/demino";

const app = demino("", [], {
	logger: createDeminoClog("my-app"),
});
```

You can use the application's logger anywhere via context:

```ts
app.use((r, i, ctx) => {
	ctx.getLogger()?.debug?.("Debug info logged from my middleware...");
});
```

## Serving static files

Static files can be served through `.static(...)` method, internally implemented with
[`@std/http/serveDir`](https://jsr.io/@std/http/doc/~/serveDir) where you can optionally
pass other [`ServeDirOptions`](https://jsr.io/@std/http/doc/~/ServeDirOptions) (except for
`fsRoot` and `urlRoot`).

```typescript
app.static('/files', '/path/to/my/files/dir', options?);
```

## Extras

All features described below are extensions to the base framework. Some batteries _are_
included after all.

## Extra: Behind a reverse proxy (`trustProxy`, `ctx.url`)

Behind a TLS-terminating proxy (nginx/Cloudflare → app over plain HTTP), the
proxy→app hop is `http`, so `new URL(req.url).protocol` is `http:` on an HTTPS site.
Two things help:

**Relative redirects (always on, no config).** `redirect()` and `trailingSlash()` emit
a **relative** `Location` for same-origin targets, so the client resolves it against
the URL it actually used and keeps its `https`. Cross-origin targets
(`redirect("https://other.example")`) stay absolute. This alone fixes the classic
`https → http → https` redirect chain behind a proxy — no trust, no config.

**`ctx.url` + `trustProxy` (opt-in).** When you need an *absolute* self-URL (canonical
links, absolute redirects), read `ctx.url` instead of `new URL(req.url)`. By default
`ctx.url` equals `new URL(req.url)`. Set `trustProxy` to rebuild it from the proxy's
`X-Forwarded-*` headers:

```ts
const app = demino("", [], {
	// false/unset (default): forwarded headers ignored
	// true: trust X-Forwarded-Proto only (host not reflected)
	// { allowedHosts }: also trust X-Forwarded-Host/-Port, allowlist-validated
	trustProxy: { allowedHosts: ["example.com", "*.example.com"] },
});

app.get("/", (req, info, ctx) => {
	ctx.url.href; // e.g. "https://example.com/" even though the app speaks http
});
```

Forwarded headers are **client-spoofable** unless the origin is locked to the proxy, so
this is OFF by default. `X-Forwarded-Proto` is low-risk (an `http|https` enum) and
trusted whenever the flag is on; `X-Forwarded-Host` is high-risk (a forged host enables
cache poisoning / link hijack / open redirect) and is reflected only when it matches
`allowedHosts` (validated **after** URL parsing, so terminator tricks like
`evil.com#.example.com` can't smuggle a host past the allowlist). The same flag gates
`ctx.ip`: off → the direct socket peer (`X-Forwarded-For` ignored); on → resolved from
the forwarding headers. `ctx.ip` was previously ungated — see
[Breaking changes](#breaking-changes-1150).

For the full threat model (why these headers are spoofable, the per-header risk
gradient, and the operator preconditions for safely enabling `trustProxy`), see
[docs/reverse-proxy-and-forwarded-headers.md](docs/reverse-proxy-and-forwarded-headers.md).

## Extra: Bundled middlewares

### Authorization (`authz`)

A generic, **policy-free** authorization gate built on the route-metadata primitive.
Demino stays agnostic: it never knows what a permission _means_ — a route declares an
opaque permission with `withPermission(...)` (or `withPublic(...)`), and you supply a
`check(subject, permission, ctx) => boolean` that decides. Wire `@marianmeres/rbac` (or
anything) inside `check`; Demino takes no dependency on it.

```typescript
import { authz, withPermission, withPublic } from "@marianmeres/demino";
import { Rbac } from "@marianmeres/rbac"; // YOUR app imports rbac, not demino

const rbac = new Rbac(); /* ...roles/groups/rules... */

app.use(authz({
	// resolve the subject (JWT/cookie/etc.); return null for unauthenticated
	resolveSubject: (req) => verifyJwt(req.headers.get("authorization")),
	// opaque check — meaning of `permission` is entirely yours
	check: (subject, permission) => rbac.can(subject as any, permission),
}));

app.get("/health", withPublic(() => "ok"));
app.get(
	"/invoices/[id]",
	withPermission("invoice:read", (req, info, ctx) => {
		// reached only when check() returned true
	}),
);
```

Behavior: `OPTIONS` is bypassed; **deny-by-default** (a route with no declaration is 403 —
set `denyByDefault: false` for incremental adoption); a route needing a permission with no
subject is 401; `withPermission([...], h, { mode })` requires `every` (default) or `some`.
Auto-HEAD inherits the GET handler's declaration. The gate runs in normal registration
order — register it early (right after any subject-resolving middleware).

**Ownership / ABAC** stays in your `check` (load the resource from `ctx` and decide, e.g.
via an rbac rule). There is no built-in resource loader — keep coarse permission at the
gate and row-level scoping in the data layer; re-check ownership in write transactions.

**Route-pattern fallback** — for routes without a static declaration, supply a
`(method, route) => decl` resolver. `createRouteResolver` builds one from a pattern map
(`*` = one segment, `**` = the rest):

```typescript
import { authz, createRouteResolver } from "@marianmeres/demino";

const resolve = createRouteResolver([
	["/health", { public: true }],
	["/api/**", { permission: "api:access" }],
]);
app.use(authz({ resolveSubject, check, resolve })); // static decls still win
```

**Build-time coverage (the fail-closed guarantee)** — a runtime gate cannot protect
404/405 or static catch-alls, so the real guarantee is a build-time audit over
`app.routes()`. `permissionMatrix(app)` returns every `(method, route)` with its
declaration (`permission` | `public` | `MISSING`) and `source` (`static` | `resolver`);
`assertCovered(app)` throws if any route is undeclared — run it in CI:

```typescript
import { assertCovered, permissionMatrix } from "@marianmeres/demino";

Deno.test("no unguarded routes", () => assertCovered(app, { resolve }));
// or inspect/print the full matrix:
console.table(permissionMatrix(app, { resolve }));
```

Read the typed subject anywhere downstream with `getSubject<MyUser>(ctx)`.

### CORS

Will create the "Cross-origin resource sharing" ("CORS") headers in the response based on
the provided config.

Defaults: `allowOrigin: "*"`, `allowCredentials: false`. The CORS spec forbids combining
`Access-Control-Allow-Origin: *` with `Access-Control-Allow-Credentials: true`, so
`cors({ allowOrigin: "*", allowCredentials: true })` throws at construction time. To allow
credentials, provide an explicit `allowOrigin` allowlist (string, string[], or function
that returns the matched origin).

> **BREAKING (1.7.0):** `allowCredentials` defaulted to `true` in 1.6.x, and the wildcard
>
> - credentials combination was silently "fixed" by echoing back the request `Origin`
>   header — which effectively allowed credentialed requests from any origin. See
>   [BC notes](#breaking-changes-170) below.

Basic example

```ts
app.use(cors());
```

Dynamic evaluation example (with credentials)

```ts
app.use(cors({
	// string | string[] | ((orig, hdr) => string | string[] | Promise<string | string[]>)
	allowOrigin: (origin: string, reqHeaders: Headers) => {
		return (myWhitelist.includes(origin)) ? origin : "";
	},
	allowCredentials: true,
}));
```

Note that you may need to explicitly allow the `OPTIONS` request handlers. You may use a
wildcard route definition for convenience:

```ts
app.options("*", cors());
```

### Trailing slash

The default router, by design, sees `/foo` and `/foo/` as the same routes, which may not
be always desired (eg for SEO). This is where the trailing slash middleware helps.

```ts
// will ensure every request will be redirected (if needed) to the trailing slash route
app.use(trailingSlash(true));
// and the opposite:
// app.use(trailingSlash(false))
```

The 301 emits a **relative** `Location` (correct behind a TLS-terminating proxy) and
preserves the query string. See
[Behind a reverse proxy](#extra-behind-a-reverse-proxy-trustproxy-ctxurl).

### Proxy

Proxies requests to a different server with comprehensive features including SSRF
protection, host whitelisting, header/body transformation, and custom error handling.
Target can be specified as a URL string (absolute or relative) or a function. WebSocket
upgrade requests are transparently tunneled to the upstream (since 1.17.0, see below).

Basic usage:

```ts
// string target: GET /foo/bar?x=y -> GET http://some/foo/bar?x=y
app.get("/foo/*", proxy("http://some/*"));

// fn target using context: GET /search/foo -> GET https://google.com/?q=foo
app.get(
	"/search/[keyword]",
	proxy((r, c) => `https://google.com/?q=${c.params.keyword}`),
);
```

Advanced features include:

- SSRF protection (blocks private IPs, localhost, `0.0.0.0`, IPv4-mapped IPv6 in dotted
  and hex form, NAT64, CGNAT 100.64.0.0/10, and link-local — see caveat below)
- Redirect re-validation: upstream redirects are followed manually and **every hop** is
  re-checked against the SSRF / `allowedHosts` policy (a permitted upstream cannot 3xx the
  proxy into an internal host); bounded by `maxRedirects` (default 5)
- Host whitelisting with wildcard support
- Request/response header transformation
- Response body transformation
- Configurable timeout and caching
- Custom error handling
- Transparent WebSocket proxying (on by default; `webSockets: false` to disable)

> **WebSockets** (since 1.17.0): a well-formed WebSocket upgrade request is tunneled to
> the upstream (`http(s)` targets are dialed as `ws(s)`). The upstream is dialed FIRST —
> the full target policy (self-proxy / SSRF / `allowedHosts`) applies, request headers
> (cookies, authorization, custom `headers`, `transformRequestHeaders`, `X-Forwarded-*`,
> hop-counter loop guard) are forwarded, and subprotocols are negotiated end-to-end — and
> the client is upgraded only after the upstream handshake succeeds, so a failed dial
> surfaces as a regular HTTP error (502 unreachable, 504 handshake timeout, `onError`).
> Close code + reason propagate in both directions. `timeout` bounds only the upstream
> handshake, never the tunnel lifetime. Not applied to tunnels: `maxRedirects`, `cache`,
> and the response transforms.

> **SSRF caveat:** `preventSSRF` is a string-only check on the target hostname. It does
> NOT resolve DNS, so it cannot block a public hostname that resolves (or is rebound) to a
> private IP. If you need protection against DNS rebinding attacks, resolve the hostname
> yourself (e.g. via `Deno.resolveDns`) and re-check each resulting address.

See [proxy.ts](src/middleware/proxy/proxy.ts) for full API documentation and examples.

### Redirect

Will create a middleware which will redirect to the provided `url` (relative or absolute)
with provided optional `status`.

```ts
app.use("/old", redirect("/new"));
```

Same-origin targets emit a **relative** `Location` (so they work correctly behind a
TLS-terminating proxy); absolute/cross-origin targets are emitted unchanged. See
[Behind a reverse proxy](#extra-behind-a-reverse-proxy-trustproxy-ctxurl).

### RateLimit

Will create a [token bucket](https://en.wikipedia.org/wiki/Token_bucket) based rate limit
middleware which will throw `429 Too Many Requests` if the allowed rate is exceeded.

First argument is a `getClientId(req, info, ctx)` function, which must return a non empty
`id` (otherwise a no-op). The `id` can be anything, typically some auth token.

```ts
app.use(
	"/api",
	rateLimit(
		// As a simple example, using raw `Authorization` header as a client id
		(req) => req.headers.get("Authorization"),
		options, // see RateLimitOptions
	),
);
```

### BodyLimit

Rejects oversized requests _before_ the body is read, protecting the server from memory
exhaustion caused by large (accidental or malicious) uploads. It is a pure header gate —
it never consumes the request body, so it composes cleanly with downstream body parsing
and streaming/progress handling.

```ts
// global limit (note: the global form is `app.use(mw)` with NO route argument)
app.use(bodyLimit({ maxSize: 20 * 1024 * 1024 })); // 20 MiB

// or a stricter per-route limit (the stricter limit wins)
app.post("/upload", bodyLimit({ maxSize: 5 * 1024 * 1024 }), handler);
```

Behavior:

- `Content-Length` present and `> maxSize` → `413 Payload Too Large` (rejected before any
  byte is buffered).
- `Content-Length` present and within `maxSize` → allowed. `Deno.serve` uses the declared
  length as the read ceiling, so a handler can never receive more than the advertised
  bytes — an under-declared `Content-Length` cannot smuggle extra bytes past the limit.
- Body present but **no** `Content-Length` (e.g. `Transfer-Encoding: chunked`) →
  `411 Length Required`, unless `allowUnknownLength: true` is set (in which case you must
  bound the stream yourself while reading it).
- No body (GET/HEAD/empty POST) → passes through untouched.

> This is request-side protection (defense in depth). It is good practice to _also_
> configure a body size limit in any reverse proxy in front of the app (e.g. nginx
> `client_max_body_size`).

### Cookies

Parses request cookies and provides helpers for setting/deleting response cookies. Accepts
optional default options applied to all `setCookie` calls.

```ts
// Configure secure defaults once
app.use(cookies({ httpOnly: true, secure: true, sameSite: "Lax", path: "/" }));

app.get("/", (req, info, ctx) => {
	// Read cookies from request
	const sessionId = ctx.locals.cookies.session;

	// Set a cookie (defaults are applied automatically)
	ctx.locals.setCookie("session", "abc123", { maxAge: 3600 });

	// Override defaults when needed
	ctx.locals.setCookie("theme", "dark", { httpOnly: false });

	// Delete a cookie (uses path/domain from defaults)
	ctx.locals.deleteCookie("session");

	return { ok: true };
});
```

### ETag

Wraps a route handler to automatically generate ETags and handle conditional requests.
Returns `304 Not Modified` when the client's cached version matches the server's version,
saving bandwidth and processing time.

```ts
import { withETag } from "@marianmeres/demino";

// Basic usage - generates strong ETag from response body hash
app.get(
	"/api/users",
	withETag(async () => {
		const users = await db.getUsers();
		return users;
	}),
);

// First request: 200 with ETag: "abc123..."
// Second request with If-None-Match: "abc123..." -> 304 Not Modified (no body)

// Use weak ETags for faster generation (less precise validation)
app.get("/data", withETag(() => "content", { weak: true }));

// Skip hashing for responses larger than the cap (default 1 MiB).
// Set to 0 / Infinity to disable.
app.get("/large", withETag(handler, { maxSizeBytes: 5 * 1024 * 1024 }));
```

Only processes GET/HEAD requests with 2xx responses. Reads the entire response body into
memory to compute the hash, so by default responses larger than `maxSizeBytes` (1 MiB) are
returned unchanged with no ETag added. Adjust the cap (or disable it with `0`/`Infinity`)
when you knowingly accept the memory cost.

## Extra: URL Pattern router

In addition to the default [simple-router](https://github.com/marianmeres/simple-router),
Demino comes with
[URL Pattern](https://developer.mozilla.org/en-US/docs/Web/API/URL_Pattern_API) router
implementation that can be activated via the `routerFactory` factory setting.

```ts
const app = demino("", [], { routerFactory: () => new DeminoUrlPatternRouter() });
app.get("/", () => "home");
app.get("/user/:foo/section/:bar", (r, i, ctx) => ctx.params);
```

## Extra: Directory based routing

`deminoFileBased` function allows you to register routes and route handlers from the file
system. It will search the provided directory for `index.(j|t)s` and `_middleware.(j|t)s`
modules. If found, it will import and collect the exported symbols (will look for HTTP
method named exports, or default exports of array of middlewares) and apply it all to the
provided app instance.

The presence of the `index.ts` with at least one known exported symbol marks the directory
as a valid route. Any directory with path segment starting with `_` or `.` will be
skipped. The optional `_middleware.ts` are collected along the path from the beginning, so
multiple ones may be effective for the final route handler.

So, instead of writing manually:

```typescript
app.use(globalMw);
app.get('/users', usersMw, () => ...);
app.get('/users/[userId]', userMw, () => ...);
```

you can achieve the same effect like this (assuming the following directory structure):

```
+-- routes
|   +-- users
|   |   +-- [userId] (with brackets - a named segment)
|   |   |   +-- _middleware.ts (default exports [userMw])
|   |   |   +-- index.ts (with exported GET function)
|   |   +-- _middleware.ts (default exports [usersMw])
|   |   +-- index.ts (with exported GET function)
|   +--  _middleware.ts (default exports [globalMw])
```

```typescript
import { demino, deminoFileBased } from "@marianmeres/demino";

const app = demino();
await deminoFileBased(app, "./routes");
```

Note that this feature is designed to work **with the default router only**.

A missing root directory is a hard error by default (it throws a `Deno.errors.NotFound`),
since at boot time it usually signals a typo or a wrong working directory. For the
legitimate "optional dir" case, pass `ignoreMissingRootDir: true` to skip absent roots
with a warning instead. See [API.md](API.md#deminofilebased) for all options.

## Extra: Apps composition (Route groups)

Multiple Demino apps on different mount paths can be composed into a single app. This is
useful for organizing routes into logical groups (e.g., API routes, admin routes, public
routes) where each group has its own isolated middleware stack.

```typescript
import { demino, deminoCompose } from "@marianmeres/demino";

// Main app for public routes
const app = demino();
app.get("/", () => "Home");
app.get("/about", () => "About");

// API routes group - all routes will be prefixed with /api
const api = demino("/api");
api.use(validateToken); // Applies to all /api/* routes
api.get("/users", getUsers); // GET /api/users
api.post("/users", createUser); // POST /api/users
api.get("/users/[id]", getUser); // GET /api/users/123
api.delete("/users/[id]", deleteUser); // DELETE /api/users/123

// Admin routes group - all routes will be prefixed with /admin
const admin = demino("/admin");
admin.use(requireAdmin); // Applies to all /admin/* routes
admin.get("/dashboard", getDashboard); // GET /admin/dashboard
admin.get("/users", getAllUsersWithDetails); // GET /admin/users
admin.delete("/users/[id]", permanentlyDeleteUser); // DELETE /admin/users/123

// Compose all apps together and serve as a single handler
Deno.serve(deminoCompose([app, api, admin]));
```

Each group has its own isolated middleware stack, making it easy to apply authentication,
validation, or logging to specific route groups without affecting others.

## Extra: Server-Sent Events (SSE)

While Demino doesn't provide a dedicated SSE abstraction, implementing SSE endpoints is
straightforward since SSE is just a `Response` with `Content-Type: text/event-stream` and
a `ReadableStream` body.

```typescript
app.get("/events", (req) => {
	let intervalId: number;

	const stream = new ReadableStream({
		start(controller) {
			// Send initial connection message
			controller.enqueue(`data: ${JSON.stringify({ connected: true })}\n\n`);

			intervalId = setInterval(() => {
				controller.enqueue(`data: ${JSON.stringify({ tick: Date.now() })}\n\n`);
			}, 1000);

			// Handle client disconnect via AbortSignal
			req.signal.addEventListener("abort", () => {
				clearInterval(intervalId);
				controller.close();
			});
		},
		cancel() {
			clearInterval(intervalId);
		},
	});

	return new Response(stream.pipeThrough(new TextEncoderStream()), {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
		},
	});
});
```

Named events can be sent using the `event:` field:

```typescript
controller.enqueue(`event: user-joined\ndata: ${JSON.stringify(user)}\n\n`);
```

## Breaking changes (1.15.0)

### `ctx.ip` is now gated by `trustProxy`

`ctx.ip` previously trusted `X-Forwarded-For` / `X-Real-IP` / `CF-Connecting-IP`
**unconditionally**, which is spoofable by any client that can reach the origin without
going through the proxy. Now `ctx.ip` follows
[`trustProxy`](#extra-behind-a-reverse-proxy-trustproxy-ctxurl): with it **off**
(default) it is the direct socket peer and those headers are ignored; with it **on** it
is resolved from them (unchanged from before). If your app sits behind a proxy and reads
`ctx.ip` (or keys `rateLimit()` on it), set `trustProxy` to keep seeing the real client
IP. This is the secure default and matches how `ctx.url` treats forwarded headers.

> Same-origin `redirect()` / `trailingSlash()` `Location` headers are now **relative**
> instead of absolute (functionally equivalent for clients). Only relevant if you assert
> an exact absolute `Location` in tests.

## Breaking changes (1.7.0)

This release changes a handful of defaults and internal APIs to fix correctness and
security issues. Most apps won't need any code changes — the affected areas are listed
below in order of likely impact.

### CORS — `allowCredentials` defaults to `false`

`cors()` previously defaulted `allowCredentials: true` while also defaulting
`allowOrigin: "*"`. The CORS spec forbids that combination, so the middleware silently
rewrote the wildcard to the request's `Origin` header — effectively allowing credentialed
requests from **any** origin out of the box.

Now:

- The default is `allowCredentials: false`.
- Constructing `cors({ allowOrigin: "*", allowCredentials: true })` throws a `TypeError`.
- If a dynamic `allowOrigin` function returns `"*"` while credentials are enabled, the
  middleware refuses to set the headers (and logs a warning) instead of echoing back the
  request origin.

**Migration:** to allow credentials, pass an explicit allowlist:

```ts
// before (1.6.x — silently insecure)
app.use(cors());

// after (1.7.0)
app.use(cors({
	allowOrigin: ["https://app.example.com", "https://admin.example.com"],
	allowCredentials: true,
}));
```

### Default logger now emits access logs

Previously the default logger was `console as DeminoLogger`, but `console` has no `access`
method, so access logs were silently swallowed unless you supplied a custom logger. The
default adapter now wires `access` to `console.log` (prefixed with `[access]`).

**Migration:** if you relied on the previous "silent default" behavior, set the logger to
`null` (`app.logger(null)`) or supply a logger whose `access` method is a no-op.

### `withTimeout()` passes an `AbortSignal` to the wrapped function

`withTimeout(fn)` now invokes `fn(...args, signal)`, so functions can actually cancel
their work on timeout instead of having it run to completion in the background. Functions
that don't accept the extra argument simply ignore it, but TypeScript will surface the
extra positional parameter — update signatures to `(...args, signal?: AbortSignal)` if the
additional argument matters to your callers.

### SSRF protection covers more cases

`isPrivateHost()` (used by `proxy({ preventSSRF: true })`) now also detects:

- `0.0.0.0` and `::` (unspecified addresses)
- IPv4-mapped IPv6 (`::ffff:127.0.0.1`)
- CGNAT range `100.64.0.0/10`
- Bracketed IPv6 hostnames (`[::1]`)

If you have tests that asserted `isPrivateHost("0.0.0.0") === false`, they now return
`true`. There is no DNS resolution, so DNS-rebinding attacks are still possible — see the
caveat in the Proxy section.

### ETag middleware skips bodies larger than 1 MiB by default

`withETag(handler)` used to buffer the entire response body to compute a SHA-1 hash with
no size limit. It now defaults to `maxSizeBytes: 1_048_576` (1 MiB) and returns the
response unchanged (no ETag, no 304 negotiation) when the body is larger.

**Migration:** if you knowingly need ETags on larger payloads, raise the cap:
`withETag(handler, { maxSizeBytes: 10 * 1024 * 1024 })`. Pass `0` or `Infinity` to disable
the cap entirely.

### Internal: per-(method, route) middleware stack is cached

The assembled `Midware` for each `(method, route)` is now cached and reused across
requests. The cache is invalidated whenever `app.use(...)` mutates the global stacks or a
route is registered. This is a transparent perf change — no API change — but if you were
relying on a per-request side effect inside the array assembly, that's no longer
happening.

## Extra: Listen info logging

A convenience `onListen` callback for `Deno.serve()` that prints the server's listening
URL(s) to the console. When bound to `0.0.0.0`, it displays both `localhost` and all
detected network addresses.

```ts
import { deminoCompose, logListenInfo } from "@marianmeres/demino";

Deno.serve(
	{
		port: parseInt(Deno.env.get("SERVER_PORT") || "") || undefined,
		hostname: Deno.env.get("SERVER_HOST") || undefined,
		onListen: logListenInfo,
	},
	deminoCompose([app, api, admin]),
);
```
