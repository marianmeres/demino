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

The actual _route_ matching is handled by the router.
By default, Demino uses [simple-router](https://github.com/marianmeres/simple-router), 
but ships with some additional implementations as well.

```typescript
// create a Demino with a `/api` mount path
const api = demino("/api");

// will handle `HTTP GET /api/users/123`
api.get("/users/[userId]", (req, info, ctx) => Users.find(ctx.params.userId));
```

For more details [see the simple-router docs](https://github.com/marianmeres/simple-router).

## Route handlers and middlewares

The stuff happens in route handlers. Or in middlewares. Or in both. In fact, 
they are technically the same thing - the route handler is just the final middleware in 
the internal collection.

Having said that, they are still expected to behave a little differently. Middlewares 
mainly _do_ something (eg validate), while route handlers mainly _return_ something 
(eg html string or json objects).

As soon as any middleware decides to _return_ a thing, the middlewares 
execution chain is terminated and a `Response` is sent immediately.

Unlike in `Deno.serve` handlers, the Demino route handlers are not required
to return a `Response` instance. The `Response` will be created automatically 
based on what they return:

- if the value is `undefined`, empty `204 No Content` response will be created,
- if the value is a plain object (or `null`, or `toJSON` aware) it will 
  be `JSON.stringify`-ed,
- everything else is cast to string.

You can safely bypass this opinionated behavior by returning the `Response` instance
yourself.

```typescript
const app = demino();

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

The middleware and/or route handler has the following signature:
```typescript
function handler(req: Request, info: Deno.ServeHandlerInfo, context: DeminoContext): any;
```

Middlewares can be registered as:
- `app.use(middleware)` - globally per app, 
- `app.use("/route", middleware)` - globally per route, will be invoked for every route http method, or
- `app.get("/route", middleware, handler)` - locally per route + method

Note that global ones must be registered _before_ the local ones to take effect.

```typescript
// GOOD
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

Each middleware receives a `DeminoContext` object which visibility and lifetime is limited 
to the scope and lifetime of the request handler. 

It has `params` (router parsed params), `headers` (to be used in the final response), 
`error` (to be used in a custom error handler) and `locals` props. 
The `locals` prop is where each middleware can read and write arbitrary data.

```typescript
const app = demino('/articles');

// example middleware loading article (from DB, let's say)...
app.use(async (_req, _info, ctx) => {
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

## Apps composition

Multiple Demino apps can be composed into a single app. 
This is useful if you want to logically group certain mount paths with the same middlewares. For example:

```typescript
import { demino, deminoCompose } from "@marianmeres/demino";

// landing page example
const home = demino("", loadMetaOgData);
home.get("/", ...);
home.get("/[slug]", ...);

// api example (note that middlewares can be added via factory as well)
const api = demino("/api", [addJsonHeader, validateBearerToken]);
api.get("/[entity]/[id]", ...);
api.post("/[entity]", ...);

// compose all together, and serve as a one handler
Deno.serve(deminoCompose([home, api]));
```

The same effect can be achieved without the composition like this:

```typescript
const app = demino();

// home
app.get("/", loadMetaOgData, ...);
app.get("/[slug]", loadMetaOgData, ...);

// api
app.get("/api/[entity]/[id]", [addJsonHeader, validateBearerToken], ...);
app.post("/api/[entity]", [addJsonHeader, validateBearerToken], ...);

Deno.serve(app);
```

## Non-default routing

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

