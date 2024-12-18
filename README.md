# @marianmeres/demino

[![JSR](https://jsr.io/badges/@marianmeres/demino)](https://jsr.io/@marianmeres/demino)

"Demino" (Deno minimal) - minimalistic web server framework built on top of the 
Deno's built-in HTTP server, providing **routing**, **middlewares support**, **error handling**, 
and a little more...

## Batteries are NOT included

The design goal of this project is to provide a thin [sweet](https://en.wikipedia.org/wiki/Syntactic_sugar) 
extensible layer on top of the `Deno.serve` handler. Nothing more, nothing less.
In other words, this is a base framework, not a full featured web server.

## Beta

Despite being marked as `1.0.x`, it is still in its early stages, where the
API may occasionally change.

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
`mountPath` is an empty string. Every `route` is then
joined as `mountPath + route`, which - when joined - must begin with a `/`.

## Routing

Every incoming request in Demino app is handled based on its `pathname` which is matched
against the registered _routes_.

The actual route matching is handled by the router.
By default, Demino uses [simple-router](https://github.com/marianmeres/simple-router).

```typescript
// create a Demino with a `/api` mount path
const api = demino("/api");

// will handle `HTTP GET /api/users/123`
api.get("/users/[userId]", (req, info, ctx) => Users.find(ctx.params.userId));
```

Demino also comes with [URLPattern based](https://developer.mozilla.org/en-US/docs/Web/API/URL_Pattern_API) 
router. Read more about it below.

##  Middlewares and route handlers

The stuff happens in route handlers. Or in middlewares. Or in both. In fact, 
they are technically the same thing - the route handler is just the final middleware in 
the internal collection.

Having said that, they are still expected to behave a little differently. Middlewares 
mainly _do_ something (eg validate), while route handlers mainly _return_ something 
(eg html string or json objects).

As soon as any middleware decides to _return_ a thing, the middlewares 
execution chain is terminated and a `Response` is sent immediately.

Unlike in `Deno.serve` handlers, the Demino route handlers are not required
to return a `Response` instance, it will be created automatically 
based on what they return:

- if the value is `undefined`, empty `204 No Content` response will be created,
- if the value is a plain object (or `null`, or `toJSON` aware) it will 
  be `JSON.stringify`-ed and served as `application/json` content type,
- everything else is cast to string as `text/html`.

You can safely bypass this opinionated behavior by returning the `Response` instance
yourself.

```typescript
// conveniently return plain object and have it be converted 
// to a Response instance automatically
app.get("/json", () => ({ this: 'will', be: 'JSON', string: 'ified'}));

// or return any other type (the `toString` method, if available, will be invoked by js)
class MyRenderer {
    constructor(private data) {...}
    toString() { return `...`; }
}
app.get('/templated', (_r, _i, c) => new MyRenderer(c.locals))

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
- `app.use(middleware)` - globally per app (will be invoked for every method on every route),
- `app.use("/route", middleware)` - globally per route (will be invoked for every method on a given route),
- `app.get("/route", middleware, handler)` - locally for given method and route.

The global ones must be registered _before_ the local ones to take effect.

```typescript
// GOOD - the globals are registered before the final handler
app
    .use(someGlobal)
    .use("/secret", authCheck)
    .get("/secret", readSecret, handler);

// BAD! neither `someGlobal` nor `authCheck` will be used for the `GET /secret` route
app
    .get("/secret", readSecret, handler)
    .use("/secret", authCheck)
    .use(someGlobal);
```

## Context

Each middleware receives a `DeminoContext` object as its last parameter 
which visibility and lifetime is limited to the scope and lifetime of the request handler. 

It has `params` (router parsed params), `headers` (to be used in the final response), 
`error` (to be used in a custom error handler) and `locals` props. 
The `locals` prop is where each middleware can read and write arbitrary data.

```typescript
const app = demino('/articles');

// example middleware loading article (from DB, let's say)...
app.use(async (_req: Request, _info: Deno.ServeHandlerInfo, ctx: DeminoContext) => {
    // eg any route which will have an `/[articleId]/` segment, we automatically read
    // article data (which also means, it will auto validate the parameter)
    if (ctx.params.articleId) {
        ctx.locals.article = await Article.find(ctx.params.articleId);
        if (!ctx.locals.article) {
            throw new ArticleNotFound(`Article ${ctx.params.articleId} not found`);
        }
    }
})

// ...and route handler acting as a pure renderer. This handler will not 
// be reached if the article is not found
app.get("/[articleId]", (_req, _info, ctx) => render(ctx.locals.article));
```

## Error handling

Errors are caught and passed to the error handler. The built-in error handler can be 
replaced via the `app.error` method (eg `app.error(myErrorHandler)`):

```typescript
// example: customized json response error handler 
app.error((_req, _info, ctx) => {
    ctx.headers.set("content-type", "application/json");
    return new Response(
        JSON.stringify({ ok: false, message: ctx.error.message }),
        { status: error?.status || 500, headers: ctx.headers }
    );
});
```

## Extras

All features described below are extensions to the base framework
(some batteries are included after all).

## Extra: Bundled middlewares

### Trailing slash
The default router, by design, sees `/foo` and `/foo/` as the same routes, 
which may not be always desired (eg for SEO). This is where the trailing slash 
middleware helps.

```ts
// will ensure every request will be redirected (if needed) to the trailing slash route
app.use(trailingSlash(true))
// and the opposite:
// app.use(trailingSlash(false))
```

### Cors

Work in progress...

## Extra: URLPattern router

In addition to the default [simple-router](https://github.com/marianmeres/simple-router), 
Demino comes with [URLPattern](https://developer.mozilla.org/en-US/docs/Web/API/URL_Pattern_API) 
router implementation that can be activated via the `routerFactory` factory setting.

```ts
const app = demino("", [], { routerFactory: () => new DeminoUrlPatternRouter() });
app.get("/", () => "home");
app.get("/user/:foo/section/:bar", (_r, _i, ctx) => ctx.params);
```

## Extra: Directory based routing

`deminoFileBased` function allows you to register routes and route handlers from the file system.
It will search the provided directory for `index.(j|t)s` and `_middleware.(j|t)s` modules.
If found, it will import and collect the exported symbols (will look for HTTP method named 
exports, or default exports of array of middlewares) and apply it all to the provided app instance.

The presence of the `index.ts` with at least one known exported symbol marks the directory 
as a valid route. Any directory with path segment starting with `_` or `.` will be skipped. The 
optional `_middleware.ts` are collected along the path from the beginning, so 
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
await deminoFileBased(app, './routes')
```

Note that this feature is designed to work **with the default router only**.

## Extra: Apps composition

Multiple apps on a different mount paths can be composed into a single app. 
For example:

```typescript
import { demino, deminoCompose } from "@marianmeres/demino";

// skipping routes setup here...
const home = demino("", loadMetaOgData);
const api = demino("/api", [addJsonHeader, validateBearerToken]);

// compose all together, and serve as a one handler
Deno.serve(deminoCompose([home, api]));
```

