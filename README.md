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

## Application Locals

Unlike `ctx.locals` which is request-scoped, `app.locals` provides application-wide
shared data accessible from any handler via `ctx.appLocals`.

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

By default all errors (except `404`s) are logged using application's `logger.error(...)`.

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
complete logger with access logging using [`@marianmeres/clog`](https://jsr.io/@marianmeres/clog):

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

## Extra: Bundled middlewares

### CORS

Will create the "Cross-origin resource sharing" ("CORS") headers in the response based on
the provided config.

Defaults: `allowOrigin: "*"`, `allowCredentials: false`. The CORS spec forbids combining
`Access-Control-Allow-Origin: *` with `Access-Control-Allow-Credentials: true`, so
`cors({ allowOrigin: "*", allowCredentials: true })` throws at construction time. To allow
credentials, provide an explicit `allowOrigin` allowlist (string, string[], or function
that returns the matched origin).

> **BREAKING (1.7.0):** `allowCredentials` defaulted to `true` in 1.6.x, and the wildcard
> + credentials combination was silently "fixed" by echoing back the request `Origin`
> header — which effectively allowed credentialed requests from any origin. See
> [BC notes](#breaking-changes-170) below.

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

### Proxy

Proxies requests to a different server with comprehensive features including SSRF protection,
host whitelisting, header/body transformation, and custom error handling. Target can be
specified as a URL string (absolute or relative) or a function. Does NOT support WebSockets.

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
- SSRF protection (blocks private IPs, localhost, `0.0.0.0`, IPv4-mapped IPv6,
  CGNAT 100.64.0.0/10, and link-local — see caveat below)
- Host whitelisting with wildcard support
- Request/response header transformation
- Response body transformation
- Configurable timeout and caching
- Custom error handling

> **SSRF caveat:** `preventSSRF` is a string-only check on the target hostname. It does
> NOT resolve DNS, so it cannot block a public hostname that resolves (or is rebound) to
> a private IP. If you need protection against DNS rebinding attacks, resolve the
> hostname yourself (e.g. via `Deno.resolveDns`) and re-check each resulting address.

See [proxy.ts](src/middleware/proxy/proxy.ts) for full API documentation and examples.

### Redirect

Will create a middleware which will redirect to the provided `url` (relative or absolute)
with provided optional `status`.

```ts
app.use("/old", redirect("/new"));
```

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

### Cookies

Parses request cookies and provides helpers for setting/deleting response cookies.
Accepts optional default options applied to all `setCookie` calls.

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
straightforward since SSE is just a `Response` with `Content-Type: text/event-stream` and a
`ReadableStream` body.

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

Previously the default logger was `console as DeminoLogger`, but `console` has no
`access` method, so access logs were silently swallowed unless you supplied a custom
logger. The default adapter now wires `access` to `console.log` (prefixed with
`[access]`).

**Migration:** if you relied on the previous "silent default" behavior, set the logger to
`null` (`app.logger(null)`) or supply a logger whose `access` method is a no-op.

### `withTimeout()` passes an `AbortSignal` to the wrapped function

`withTimeout(fn)` now invokes `fn(...args, signal)`, so functions can actually cancel
their work on timeout instead of having it run to completion in the background. Functions
that don't accept the extra argument simply ignore it, but TypeScript will surface the
extra positional parameter — update signatures to `(...args, signal?: AbortSignal)` if
the additional argument matters to your callers.

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
`withETag(handler, { maxSizeBytes: 10 * 1024 * 1024 })`. Pass `0` or `Infinity` to
disable the cap entirely.

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
