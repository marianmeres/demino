# @marianmeres/demino (BETA)

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

## Beta

Despite being marked as `1.0.x`, it is still in its early stages, where the API may
occasionally change.

## Installation

```sh
deno add jsr:@marianmeres/demino
```

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

The Demino logger, if not provided, defaults to `console`. You can provide a custom
logger:

- when creating the app via `DeminoOptions` (eg
  `demino("", [], { logger: myCustomLogger })`)
- or anytime later via `app.logger(logger: DeminoLogger)`

If you do not wish the default `console` to be active, you must turn it off explicitly via
`app.logger(null)`

The access log `logger.access` is not provided by the `console`, so if you wish to log
access, you have to provide your own implementation. For example:

```ts
// example to log access to console as well
const app = demino("", [], {
    logger: { ...console, access: (data) => console.log(data) },
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

Will create the "Cross-origin resource sharing" ("CORS") headers in the response
based on the provided config. Be aware that the default config is quite relaxed (allows
wildcards and credentials by default).

Basic example
```ts
app.use(cors());
```

Dynamic evaluation example
```ts
app.use(cors({
    // string | string[] | ((orig, hdr) => string | string[] | Promise<string | string[]>)
    allowOrigin: (origin: string, reqHeaders: Headers) => {
        return (myWhitelist.includes(origin)) ? origin : "";
    },
    allowCredentials: true
}));
```

Note that you may need to explicitly allow the `OPTIONS` request handlers. You may use a wildcard
route definition for convenience:

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

Will proxy the current request to `target`. Target can be specified either as a plain url
string (absolute or relative) or a function resolving to one. Currently does NOT support
websockets.

Signature:

```ts
function proxy(
    target: string | ((req: Request, ctx: DeminoContext) => string | Promise<string>),
    options?: Partial<{ timeout: number }>,
): DeminoHandler;
```

```ts
// string target: GET /foo/bar?x=y -> GET http://some/foo/bar?x=y
app.get("/foo/*", proxy("http://some/*"));

// fn target using req: GET /foo/bar?x=y -> GET http://some/bar (no query)
app.get("/foo/*", proxy((r) => `http://some/${new URL(r.url).pathname.slice(4)}`));

// fn target using context: GET /search/foo -> GET https://google.com/?q=foo
app.get(
    "/search/[keyword]",
    proxy((r, c) => `https://google.com/?q=${c.params.keyword}`),
);
```

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
app.use('/api', rateLimit(
    // As a simple example, using raw `Authorization` header as a client id
    (req) => req.headers.get('Authorization'), 
    options // see RateLimitOptions
));
```

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
import { join, relative } from "@std/path";

const app = demino();
await deminoFileBased(app, "./routes");
```

Note that this feature is designed to work **with the default router only**.

## Extra: Apps composition

Multiple apps on a different mount paths can be composed into a single app. For example:

```typescript
import { demino, deminoCompose } from "@marianmeres/demino";

// skipping routes setup here...
const home = demino("", loadMetaOgData);
const api = demino("/api", [addJsonHeader, validateBearerToken]);

// compose all together, and serve as a one handler
Deno.serve(deminoCompose([home, api]));
```
