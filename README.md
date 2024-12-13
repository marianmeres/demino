# @marianmeres/demino

[![JSR](https://jsr.io/badges/@marianmeres/demino)](https://jsr.io/@marianmeres/demino)

"Demino" (Deno minimal) - minimalistic web server framework built on top of the 
Deno's built-in HTTP server, providing **routing**, **middlewares support**, **error handling**, and more...

The API is designed to resemble the Express-like look and feel.

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

For more details [see the simple-router docs](https://github.com/marianmeres/simple-router).

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
app.get("/", () => ({ this: 'will', be: 'JSON stringified'}));

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
 
## Bundled middlewares

### Trailing slash
The default router, by design, sees `/foo` and `/foo/` as the same routes, 
which may not be always desired (eg for SEO). This is where the trailing slash 
middleware helps.

```ts
// will ensure every request will be redirected (if needed) 
// to the trailing slashed route
app.use(createTrailingSlash(true))

// and the opposite
app.use(createTrailingSlash(false))
```

## Extra: Custom routing

For the fun of it, in addition to the default [simple-router](https://github.com/marianmeres/simple-router), 
Demino ships with some additional router implementations that can be activated
via the `routerFactory` factory setting.

### Express-like router

```ts
const app = demino("", [], { routerFactory: () => new DeminoExpressLikeRouter() });

app.get("/", () => "home");

app.get("/user/:foo/section/:bar", (_r, _i, ctx) => ctx.params);
```

Also available: [`DeminoFixedRouter`](./src/router/fixed-router.ts),
[`DeminoRegexRouter`](./src/router/regex-router.ts).

### Integrating a 3rd party routing library

For inspiration, see the [source of the most basic one](./src/router/fixed-router.ts).


## Extra: file based routing

Work in progress...

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

