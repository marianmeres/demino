# @marianmeres/demino

[![NPM](https://img.shields.io/npm/v/@marianmeres/demino)](https://www.npmjs.com/package/@marianmeres/demino)
[![JSR](https://jsr.io/badges/@marianmeres/demino)](https://jsr.io/@marianmeres/demino)
[![License](https://img.shields.io/npm/l/@marianmeres/demino)](LICENSE)

Demino is a minimalistic web server framework built on web standards (`Request` in,
`Response` out), running on **Deno and Node**, providing:

- **routing**,
- **middlewares support**,
- **error handling**,
- **logging**
- and a little more.

## Batteries are NOT included

The design goal of this project is to provide a thin and
[sweet](https://en.wikipedia.org/wiki/Syntactic_sugar) extensible layer on top of a plain
`(request, info) => Response` handler. Nothing more, nothing less. In other words, this is a
building blocks framework, not a full featured web server.

## Installation

```sh
deno add jsr:@marianmeres/demino
# or
npm install @marianmeres/demino
```

The npm package needs Node 22 or newer. WebSocket upgrades on Node need the optional
[`ws`](https://www.npmjs.com/package/ws) package (`npm install ws`); without it the Node adapter
serves plain HTTP and warns once.

## API Documentation

For complete API reference, see [API.md](API.md).

## Basic usage

```ts
import { demino } from "@marianmeres/demino";
import { serve } from "@marianmeres/demino/deno"; // or "/node"

// create the Demino app instance
const app = demino();

// register method and route handlers...
app.get("/", () => "Hello, World!");

// serve through the runtime adapter (the same call on every runtime)
await serve(app);
```

On Deno the adapter is optional: a Demino app is a plain `(req, info) => Response` function, so
`Deno.serve(app)` keeps working as it always did (see [Runtimes](#runtimes) for what the adapter
adds).

## Table of Contents

- [The app](#the-app)
- [Mount path](#mount-path)
- [Routing](#routing)
- [Middlewares and route handlers](#middlewares-and-route-handlers)
- [Context](#context)
- [Application Locals](#application-locals)
- [Error handling](#error-handling)
- [Response hooks](#response-hooks)
- [Application log](#application-log)
- [Serving static files](#serving-static-files)
- [Runtimes](#runtimes)
- [Testing](#testing)
- [Extras](#extras)
  - [Behind a reverse proxy](#extra-behind-a-reverse-proxy-trustproxy-ctxurl)
  - [Bundled middlewares](#extra-bundled-middlewares): [authz](#authorization-authz),
    [CORS](#cors), [trailing slash](#trailing-slash), [proxy](#proxy),
    [redirect](#redirect), [rate limit](#ratelimit), [body limit](#bodylimit),
    [cookies](#cookies), [ETag](#etag)
  - [URL Pattern router](#extra-url-pattern-router)
  - [Directory based routing](#extra-directory-based-routing)
  - [Apps composition (Route groups)](#extra-apps-composition-route-groups)
  - [Server-Sent Events (SSE)](#extra-server-sent-events-sse)
  - [Listen info logging](#extra-listen-info-logging)
- [Upgrading](#upgrading)

## The app

The `demino` function creates the app. It takes up to four arguments, all of them optional:

```ts
const app = demino(mountPath, middleware, options, appLocals);
```

- `mountPath` - the route prefix (see [Mount path](#mount-path) below), an empty string by
  default,
- `middleware` - a middleware (or an array of them) to run on every request, the same as
  calling `app.use(...)` later,
- `options` - the `DeminoOptions` (listed below),
- `appLocals` - the initial [application locals](#application-locals).

So the `demino("", [], { ... })` you will see in the examples is just an app with no mount
path, no middlewares and some options.

The options are:

- `logger` - the [application logger](#application-log), or `null` to turn the logging off,
- `errorHandler` - a custom [error handler](#error-handling), the same as `app.error(...)`,
- `onResponse` - one or more [response hooks](#response-hooks), the same as
  `app.onResponse(...)`,
- `routerFactory` - a function returning a custom router instance (eg the
  [URL Pattern router](#extra-url-pattern-router)),
- `trustProxy` - whether to trust the `X-Forwarded-*` headers, off by default (see
  [Behind a reverse proxy](#extra-behind-a-reverse-proxy-trustproxy-ctxurl)),
- `noXPoweredBy`, `noXResponseTime` - do not send the `X-Powered-By` and `X-Response-Time`
  headers (both are sent by default),
- `verbose` - log every route as it is registered.

See [API.md](API.md#deminooptions) for the details.

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

Routes are registered through the method named functions: `app.get`, `app.post`, `app.put`,
`app.patch`, `app.delete`, `app.options` (and the less common `app.connect` and `app.trace`),
or through `app.all` for any method. A few things are handled for you:

- every `GET` (and `all`) route answers the `HEAD` requests as well, with the same headers
  and no body (the "auto-HEAD"),
- a request to an existing route with a method it does not serve gets
  `405 Method Not Allowed` with the `Allow` header,
- anything else unmatched gets `404 Not Found`.

Demino also comes with
[URL Pattern](https://developer.mozilla.org/en-US/docs/Web/API/URL_Pattern_API) based
router. Read more about it below.

### Catch-all (`*`) precedence

A `*` catch-all always resolves **globally last** - it only fires once nothing else
matched. The effective order is: real routes (any method) → catch-all routes. So a
catch-all never shadows a more specific route, regardless of the HTTP method it was
registered on:

```typescript
import { createHttpError } from "@marianmeres/http-utils";

app.get("/", () => "home");
app.all("/files/*", () => "static");
app.get("*", () => {
	throw createHttpError(404);
}); // your own "not found" fallback

// GET /files/logo.png -> "static"  (the .all() route wins over the GET catch-all)
// GET /              -> "home"
// GET /anything-else -> 404        (the catch-all fires only here)
```

### Route introspection (`app.routes()`)

`app.routes()` enumerates every registered `(method, route, meta)` — mirroring the
dispatcher match-set (ALL router, catch-alls, auto-HEAD). It is the read-side companion to
[`routeMeta`](#static-route-metadata-ctxroutemeta--withmeta) (described below), intended for
build-time introspection and audits (permission coverage, OpenAPI/sitemap generation,
cache-policy checks):

```typescript
for (const { method, route, meta } of app.routes()) {
	// e.g. assert every route declares a permission, or build a permission matrix
}
```

## Middlewares and route handlers

The stuff happens in route handlers. Or in middlewares. Or in both. In fact, they are
technically the same thing - the route handler is just the final middleware in the
internal collection.

Having said that, they are still expected to behave a little differently. Middlewares
mainly _do_ something (eg validate), while route handlers mainly _return_ something (eg
html string or json objects).

As soon as any middleware decides to _return_ a thing, the middlewares execution chain is
terminated and a `Response` is sent immediately.

Unlike a bare server handler, the Demino route handlers are not required to return a
`Response` instance, it will be created automatically based on what they return:

- if the final returned value is `undefined` (no middleware returned a defined value),
  empty `204 No Content` response will be created,
- if any returned value is a plain object or array (or `null`, or `toJSON` aware) it will
  be `JSON.stringify`-ed and served as `application/json` content type,
- if any middleware threw (or returned) an `Error`, error response is generated,
- everything else is cast to string and served as `text/html`.

The automatic content type headers above are only set if none exist.

You can safely bypass this opinionated behavior by returning the `Response` instance
yourself. Its body, its status and its own headers are sent as they are. The headers set on
`ctx.headers` are added to it where it does not carry them already (see [Context](#context)).

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

The middleware and/or route handler has the following signature (the first two arguments are
exactly what the runtime adapter passes to the app itself, so any `(req, info) => Response`
server handler is also a valid Demino handler):

```typescript
function handler(req: Request, info: DeminoServeInfo, context: DeminoContext): any;
```

`DeminoServeInfo` is the portable version of a runtime's own "serve handler info":
`remoteAddr`, the optional `upgradeWebSocket` capability and the untyped `raw` runtime object -
see [Runtimes](#runtimes). All of its fields are optional (the app can also be called directly,
with no `info` at all - see [Testing](#testing)).

Middlewares can be registered as:

- `app.use(middleware)` - globally per app (will be invoked for every method on every
  route),
- `app.use("/route", middleware)` - globally per route (will be invoked for every method
  on a given route),
- `app.get("/route", middleware, handler)` - locally for given method and route.

```typescript
app.use(someGlobal).use("/secret", authCheck).get("/secret", readSecret, handler);
```

### Middleware ordering (`DEMINO_SORT`)

Middleware order is controlled by `handler.__midwarePreExecuteSortOrder` (ascending; lower
runs first). The exported `DEMINO_SORT` constant publishes the reference points Demino
assigns by default — `PRE` (100), `DEFAULT` (1000), `HANDLER` (Infinity) — so a middleware
can position itself ahead of the normal chain deterministically:

```typescript
import { DEMINO_SORT } from "@marianmeres/demino";

const gate: DeminoHandler = (req, info, ctx) => {
	/* runs first */
};
gate.__midwarePreExecuteSortOrder = DEMINO_SORT.PRE;
app.use(gate);
```

## Context

Each middleware receives a `DeminoContext` as its last parameter which visibility and
lifetime is limited to the scope and lifetime of the request handler.

It consists of:

- `params` - the readonly router parsed params,
- `locals` - plain object, where each middleware can write and read arbitrary data.
- `status` - HTTP status number to be optionally used in the final response (a returned
  `Response` instance keeps its own),
- `headers` - headers for the final response, whichever way it is produced (see below),
- `error` - to be used in a custom error handler.
- `route` - currently matched route definition
- `routeMeta` - static metadata declared on the matched route handler (see below)
- `url` - the request `URL`, which is the one the client used when `trustProxy` is on (see
  [Behind a reverse proxy](#extra-behind-a-reverse-proxy-trustproxy-ctxurl))
- `ip` - the client IP address (the socket peer, unless `trustProxy` is on)
- `appLocals` - the [application locals](#application-locals) shared by all requests
- `getLogger` - function to get the logger instance (if any) initially provided via
  `DeminoOptions` or later via `app.logger(...)` api

```typescript
const app = demino("/articles");

// example middleware loading article (from DB, let's say)...
app.use(async (req: Request, info: DeminoServeInfo, ctx: DeminoContext) => {
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

### Response headers (`ctx.headers`)

`ctx.headers` reach every response: one created from a returned value, an error response, and
a `Response` instance returned by a handler or by a custom error handler. That is how
`cors()`, `cookies()` or `rateLimit()` work on any route, whatever it returns - a static
file, a proxied response, a stream, a redirect.

A returned `Response` keeps its own headers: a header from `ctx.headers` is added only when
the response does not carry it. Two headers are merged instead: every `Set-Cookie` the
response lacks is appended, and `Vary` gains the tokens it lacks. On the error path a
`content-type` set on `ctx.headers` is dropped, because it described the body the handler
planned.

```typescript
app.use((req, info, ctx) => {
	ctx.headers.set("cache-control", "no-store");
});

// cache-control: no-store
app.get("/a", () => new Response("a"));

// cache-control: max-age=60 (the response's own wins)
app.get("/b", () => new Response("b", { headers: { "cache-control": "max-age=60" } }));
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

Errors are caught and passed to the error handler. So to end a request with an HTTP error,
just throw one:

```typescript
import { createHttpError } from "@marianmeres/http-utils";

app.get("/articles/[id]", async (req, info, ctx) => {
	const article = await Article.find(ctx.params.id);
	if (!article) throw createHttpError(404, "Article not found");
	return article;
});
```

The response status is read from the error's `status` property, and an error without it is a
`500`. So `createHttpError` is a convenience, not a requirement - any error of yours with a
`status` works the same. It comes from
[`@marianmeres/http-utils`](https://github.com/marianmeres/http-utils), the package Demino
itself uses (add it to your dependencies to import it). The app's own `404` and `405` go
through the error handler as well.

The built-in error handler responds with the error message as the body. It can be replaced
via the `app.error` method (eg `app.error(myErrorHandler)`):

```typescript
import { getErrorMessage } from "@marianmeres/http-utils";

// example: customized json response error handler
app.error((req, info, ctx) => {
	return { ok: false, message: getErrorMessage(ctx.error) };
});
```

In the error handler, `ctx.error` carries the `status`, and what was actually thrown is its
`cause`. That is why the message is read with `getErrorMessage` - the bare
`ctx.error.message` is only the status text (eg `Not Found`). The response status is always
the error's one. To send a different one, return a `Response` instance.

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

## Response hooks

A middleware ends when it returns: it can set `ctx.headers`, but it never sees the response.
A response hook is app-level code that sees _every_ response the app returns: one
built from a returned value, a `Response` a handler returned (a stream, a proxied or static
file response, a redirect), an error response (the default one or your error handler's) and
the app's own `404` / `405`.

```typescript
// nothing this app answers is cacheable unless a route says so
app.onResponse((req, info, ctx, response) => {
	if (!response.headers.has("cache-control")) {
		response.headers.set("cache-control", "private, no-store");
	}
});
```

Hooks run in registration order, once per request, after the response exists and before the
access log. Return a `Response` to replace the one in hand, or nothing to keep it. The
response in hand carries the `ctx.headers` already, and its headers are always mutable,
wherever the response came from (a `fetch()` result included). A replacement is sent as the
hook made it: build it from the one in hand (`new Response(body, response)`) to keep the
headers. `ctx` is the request's own context: `ctx.error` on the error path, `ctx.route` and
`ctx.routeMeta` of the match. Hooks are per app (see
[composition](#extra-apps-composition-route-groups)) and are skipped for a WebSocket upgrade.

A hook that throws fails the request, like a throwing middleware: the error goes to the error
handler, and that error response is sent without running the hooks again. If a hook's effect
is optional, catch inside the hook.

See [API.md](API.md#deminoresponsehook) for the details.

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

Static files are served through the `.static(route, fsRoot, options?)` method. Under the hood it
is the exported `serveStatic(req, options)` - a plain `Request` → `Response` function on
`node:fs`, the same on every runtime - mounted on `route/*`:

```typescript
app.static("/files", "/path/to/my/files/dir");

// with options (DeminoStaticOptions)
app.static("/assets", "./public", {
	showIndex: true, // serve index.html for a directory request (default true)
	showDotfiles: false, // /.env, /.well-known/x → 404 (default false)
	etag: true, // ETag + Last-Modified, 304 on If-None-Match / If-Modified-Since (default true)
	// extra headers (HeadersInit, or a per-request function) set on 200/206/304 only
	headers: (req, filePath) => ({
		"cache-control": filePath.includes("/immutable/")
			? "public, max-age=31536000, immutable"
			: "no-cache",
	}),
});
```

What you get: `GET`/`HEAD` only (anything else is a 405 with `Allow`), content types via
[`mrmime`](https://www.npmjs.com/package/mrmime) (`; charset=utf-8` on text-like types),
`Content-Length`, `Accept-Ranges` and single-range `Range` requests (206/416), a weak `ETag`,
301 redirects to the normalised path (`/a//b` → `/a/b`, a directory without a trailing slash →
with it, a file with one → without), and 404 for anything outside the root, dot-segments (unless
`showDotfiles`) and missing files. Filesystem errors other than "not found" are thrown, so they
reach your error handler. The route must not contain dynamic segments. For CORS, put the
`cors()` middleware in front (`app.use(cors())`), or set a fixed header through `headers`
(`{ "access-control-allow-origin": "*" }`).

`serveStatic` is also usable on its own, under any route of yours:

```typescript
import { serveStatic } from "@marianmeres/demino";

app.get("/public/*", (req) =>
	serveStatic(req, { fsRoot: "./public", urlRoot: "public" }),
);
```

See [API.md](API.md#static-files) for the exact behaviour and all options.

## Runtimes

The core of Demino is runtime-agnostic (web standards plus the `node:*` subset). Starting a
server is the only runtime-specific step, and it is one import away:

| Runtime | Import                     | Server underneath                      |
| ------- | -------------------------- | -------------------------------------- |
| Deno    | `@marianmeres/demino/deno` | the built-in HTTP server               |
| Node    | `@marianmeres/demino/node` | own bridge over `node:http` (HTTP/1.1) |

Every adapter exports the same `serve(handler, options?)`, resolves with the same `ServeHandle`,
and defaults to `0.0.0.0:8000` with the listen info printed (pass `onListen: () => {}` to
silence it):

```ts
import { demino } from "@marianmeres/demino";
import { serve } from "@marianmeres/demino/node";

const app = demino();
app.get("/", () => "Hello");

const server = await serve(app, {
	port: 3000, // 0 picks a free port
	hostname: "127.0.0.1",
	onListen: ({ hostname, port }) => console.log(`listening on ${hostname}:${port}`),
});

server.url; // "http://127.0.0.1:3000/"
await server.shutdown(); // graceful; Node force-closes after 5 s
```

`ServeOptions`: `port`, `hostname`, `signal` (aborting closes the server and every connection
at once), `onListen`, `onError` (for the adapter's own failures - a Demino app never throws) and,
on Node only, `webSockets` (default `true`; lazily imports `ws`). `ServeHandle`: `hostname`,
`port`, `url`, `finished`, `shutdown()`, `ref()`, `unref()`. See
[API.md](API.md#runtime-adapters).

What the adapter puts on the handler's `info` argument (a `DeminoServeInfo`):

- `remoteAddr` - the socket peer (`{ hostname, port, transport }`); what `ctx.ip` reports when
  `trustProxy` is off,
- `upgradeWebSocket(req, { protocol? })` - the WebSocket upgrade capability, with the same
  `{ socket, response }` shape on every runtime (Node: through the optional `ws`). The
  [proxy](#proxy) middleware needs it for WebSocket tunneling,
- `raw` - the runtime's own per-request object, untyped.

**Without an adapter.** On Deno, `Deno.serve(app)` works unchanged: `info` then carries
`remoteAddr` only, so everything except WebSocket tunneling behaves the same. On Node there is
no web-standard server to hand the app to, so the adapter is the way.

**Bun is not a supported runtime.** A Demino app is a web-standard handler, so
`Bun.serve({ fetch: app })` serves plain HTTP; `ctx.ip` from the socket and WebSocket tunneling
are not available there, and nothing is tested on Bun.

## Testing

A Demino app is just a function. Give it a `Request` and you get the `Response` back - no
server, no port and no runtime adapter needed:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { demino } from "@marianmeres/demino";

// `logger: null` keeps the access log out of the test output
const app = demino("", [], { logger: null });
app.get("/hello/[name]", (req, info, ctx) => ({ hello: ctx.params.name }));

test("says hello", async () => {
	const res = await app(new Request("http://localhost/hello/world"));
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), { hello: "world" });
});
```

What is missing is only what the adapter provides: `ctx.ip` is an empty string and there is
no WebSocket upgrade. To test those, start a real server on a free port
(`serve(app, { port: 0 })`, see [Runtimes](#runtimes)).

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

**`ctx.url` + `trustProxy` (opt-in).** When you need an _absolute_ self-URL (canonical
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

The forwarded headers can be forged by any client which reaches the app without going
through the proxy, so this is off by default. Turn it on only when the proxy is the only way
in. And even then, a forwarded host is used only if it matches the `allowedHosts`.

The same flag gates `ctx.ip`. When off, it is the direct socket peer (and `X-Forwarded-For`
is ignored). When on, it is resolved from the forwarding headers.

For the full threat model (why these headers are spoofable, the per-header risk
gradient, and the operator preconditions for safely enabling `trustProxy`), see
[docs/reverse-proxy-and-forwarded-headers.md](docs/reverse-proxy-and-forwarded-headers.md).

## Extra: Bundled middlewares

All of them are exported from the main entry point (and from
`@marianmeres/demino/middleware` as well), so the examples below assume an import like:

```ts
import { cookies, cors, proxy, rateLimit } from "@marianmeres/demino";
```

### Authorization (`authz`)

An authorization gate built on the
[route metadata](#static-route-metadata-ctxroutemeta--withmeta). A route declares the
permission it needs with `withPermission(...)` (or `withPublic(...)`), and you supply the
`check(subject, permission, ctx)` function which decides. Demino never knows what a
permission means, so wire `@marianmeres/rbac` (or anything else) inside the `check`.

```typescript
import { authz, withPermission, withPublic } from "@marianmeres/demino";
import { Rbac } from "@marianmeres/rbac"; // YOUR app imports rbac, not demino

const rbac = new Rbac(); /* ...roles/groups/rules... */

app.use(
	authz({
		// resolve the subject (JWT/cookie/etc.); return null for unauthenticated
		resolveSubject: (req) => verifyJwt(req.headers.get("authorization")),
		// opaque check — meaning of `permission` is entirely yours
		check: (subject, permission) => rbac.can(subject as any, permission),
	}),
);

app.get(
	"/health",
	withPublic(() => "ok"),
);
app.get(
	"/invoices/[id]",
	withPermission("invoice:read", (req, info, ctx) => {
		// reached only when check() returned true
	}),
);
```

What the gate does:

- a route with no declaration is denied with `403` (set `denyByDefault: false` to adopt it
  step by step),
- a route which needs a permission while there is no subject is a `401`,
- with more permissions (`withPermission([...], handler, { mode })`) either `every` one
  (default) or `some` must pass,
- the `OPTIONS` requests are let through.

Register it early, right after any middleware which resolves the subject. The subject can be
read anywhere downstream with `getSubject<MyUser>(ctx)`. The ownership checks (is this _my_
invoice?) are up to your `check`, or to the data layer.

A runtime gate cannot protect a `404`, a `405` or a static catch-all, so the real guarantee
is a build-time one: `assertCovered(app)` throws if any registered route is left without a
declaration. Run it in your tests:

```typescript
import { assertCovered } from "@marianmeres/demino";

test("no unguarded routes", () => assertCovered(app));
```

There is also a route-pattern fallback for the routes you cannot decorate
(`createRouteResolver`) and a full report of what is declared where (`permissionMatrix`). See
[API.md](API.md#authz) for all of it.

### CORS

Will create the "Cross-origin resource sharing" ("CORS") headers in the response based on
the provided config.

Defaults: `allowOrigin: "*"`, `allowCredentials: false`. The CORS spec forbids combining
`Access-Control-Allow-Origin: *` with `Access-Control-Allow-Credentials: true`, so
`cors({ allowOrigin: "*", allowCredentials: true })` throws at construction time. To allow
credentials, provide an explicit `allowOrigin` allowlist (string, string[], or function
that returns the matched origin).

Basic example

```ts
app.use(cors());
```

Dynamic evaluation example (with credentials)

```ts
app.use(
	cors({
		// string | string[] | ((orig, hdr) => string | string[] | Promise<string | string[]>)
		allowOrigin: (origin: string, reqHeaders: Headers) => {
			return myWhitelist.includes(origin) ? origin : "";
		},
		allowCredentials: true,
	}),
);
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
upgrade requests are transparently tunneled to the upstream (see below).

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

- SSRF protection (opt-in via `preventSSRF`, blocks localhost, private and link-local
  addresses - see the caveat below)
- Upstream redirects are followed by the proxy itself and every hop is checked again, so an
  allowed upstream cannot redirect the proxy to an internal host (`maxRedirects`, default 5)
- Host whitelisting with wildcard support
- Request/response header transformation
- Response body transformation
- Configurable timeout and caching
- Custom error handling
- Transparent WebSocket proxying (on by default; `webSockets: false` to disable)

> **WebSockets:** a WebSocket upgrade request is tunneled to the upstream (`http(s)` targets
> are dialed as `ws(s)`), under the same target policy and with the same forwarded headers as
> any other request. The upstream is dialed first and the client is upgraded only after that
> handshake succeeds, so a failed dial is a regular HTTP error (`502`, `504`) and not a
> dropped socket. The `timeout` limits the handshake only, never the life of the tunnel. The
> tunneling needs the runtime adapter's `serve()` (see [Runtimes](#runtimes)).

> **SSRF caveat:** `preventSSRF` is a string-only check on the target hostname. It does
> NOT resolve DNS, so it cannot block a public hostname that resolves (or is rebound) to a
> private IP. If you need protection against DNS rebinding attacks, resolve the hostname
> yourself (e.g. via `node:dns`) and re-check each resulting address.

See [API.md](API.md#proxy) for all the options and details.

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
- `Content-Length` present and within `maxSize` → allowed. The HTTP server (on every supported
  runtime) uses the declared length as the read ceiling, so a handler can never receive more
  than the advertised bytes — an under-declared `Content-Length` cannot smuggle extra bytes past
  the limit.
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
app.get(
	"/data",
	withETag(() => "content", { weak: true }),
);

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
import { demino, DeminoUrlPatternRouter } from "@marianmeres/demino";

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

A missing root directory is a hard error by default (it throws a plain `Error` with
`code: "ENOENT"` and `name: "NotFound"` - match on `code`, like a filesystem error), since at
boot time it usually signals a typo or a wrong working directory. For the legitimate "optional
dir" case, pass `ignoreMissingRootDir: true` to skip absent roots with a warning instead. See
[API.md](API.md#deminofilebased) for all options.

## Extra: Apps composition (Route groups)

Multiple Demino apps on different mount paths can be composed into a single app. This is
useful for organizing routes into logical groups (e.g., API routes, admin routes, public
routes) where each group has its own isolated middleware stack.

```typescript
import { demino, deminoCompose } from "@marianmeres/demino";
import { serve } from "@marianmeres/demino/deno"; // or "/node"

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
await serve(deminoCompose([app, api, admin]));
```

Each group has its own isolated middleware stack, making it easy to apply authentication,
validation, or logging to specific route groups without affecting others.

## Extra: Server-Sent Events (SSE)

While Demino doesn't provide a dedicated SSE abstraction, implementing SSE endpoints is
straightforward since SSE is just a `Response` with `Content-Type: text/event-stream` and
a `ReadableStream` body.

```typescript
app.get("/events", (req) => {
	let intervalId: ReturnType<typeof setInterval>;

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

## Extra: Listen info logging

`logListenInfo` is every runtime adapter's default `onListen` callback: it prints the server's
listening URL(s) to the console, and when bound to `0.0.0.0` (or `::`) it displays both
`localhost` and all detected network addresses. Pass it explicitly to add options, or hand it to
a runtime's own server API (its `onListen` argument satisfies the `{ hostname, port }` shape).

```ts
import { deminoCompose, logListenInfo } from "@marianmeres/demino";
import { serve } from "@marianmeres/demino/deno"; // or "/node"

await serve(deminoCompose([app, api, admin]), {
	port: parseInt(process.env.SERVER_PORT || "") || undefined,
	hostname: process.env.SERVER_HOST || undefined,
	onListen: logListenInfo,
});
```

### Structured (JSON) output

In production the pretty output is just noise - containers ship stdout to a log collector
that wants one JSON object per line. Pass `json` (and use `createLogListenInfo` to
preconfigure the callback):

```ts
import { createLogListenInfo, deminoCompose } from "@marianmeres/demino";
import { serve } from "@marianmeres/demino/deno"; // or "/node"

await serve(deminoCompose([app, api, admin]), {
	// `true` = always json, `"auto"` = json only when stdout is not a TTY
	onListen: createLogListenInfo({
		json: "auto",
		fields: { service: "api", env: process.env.ENV },
	}),
});
```

which emits a single line:

```
{"timestamp":"2026-09-13T10:11:12.000Z","level":"info","logger":"demino","message":"Demino listening: http://localhost:8000/","event":"server.listen","hostname":"0.0.0.0","port":8000,"url":"http://localhost:8000/","service":"api","env":"production"}
```

The field names match `@marianmeres/clog`'s `jsonOutput` defaults, so the line looks like
the rest of your structured logs. `fields` is merged last, so it can also override any
built-in field. Filter on `event == "server.listen"` instead of matching the message text.

Unlike the human readable mode, JSON mode does not enumerate network interfaces -
container local addresses are noise, and skipping it avoids the system-info permission some
runtimes gate it behind (Deno's `--allow-sys`).

## Upgrading

The changes which alter behavior or break something are listed per release in
[CHANGELOG.md](CHANGELOG.md). When coming from 1.x, see
[docs/MIGRATION-2.0.md](docs/MIGRATION-2.0.md) - for a typical Deno app the migration is one
`sed` and a look at your `app.static` options.

## About the name

The name originally stood for "Deno minimal" - it has since grown beyond Deno.

## License

[MIT](LICENSE)
