# @marianmeres/demino

[![JSR](https://jsr.io/badges/@marianmeres/demino)](https://jsr.io/@marianmeres/demino)

"Demino" (Deno minimal) - minimalistic web server framework built on top of the 
Deno's built-in HTTP server. 

It provides:

- routing, 
- middlewares support,
- unified error handling,
- Express-like semantics.

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

_Every_ Demino app is mounted to a specific route prefix called the `mountPath`. The default
`mountPath` is an empty string that represents the server root.

## Routing

Every incoming request in Demino app is handled based on its `pathname` which is matched
against the registered _routes_.

The actual _route_ format and parsing depends on the active router instance.
By default, Demino uses [simple-router](https://github.com/marianmeres/simple-router), but
ships with some additional implementations as well. Also, it should be 
fairly easy to integrate any 3rd-party routing library as well. More on this down below.

```typescript
// create a Demino with a `/api` mount path
const api = demino("/api");

// will handle `HTTP GET /api/users/123`
api.get("/users/[userId]", (req, info, ctx) => Users.find(ctx.params.userId));
```

For more default router details see [the simple-router docs](https://github.com/marianmeres/simple-router).

## Route handlers and middlewares

The stuff happens in route handlers. Or in middlewares. Or in both. In fact, 
they are technically the same thing - the route handler is just the final middleware in 
the internal collection.

Having said that, they are still expected to behave a little differently. Middlewares 
mainly _do_ something (eg validate), while route handlers mainly _return_ something 
(eg html string or json objects).

As soon as any middleware decides to _return_ a thing, the middlewares 
execution chain is terminated and a `Response` is sent immediately.

Unlike in `Deno.serve` handlers, the Demino route handlers are neither required nor expected
to return a `Response` instance. If they don't, the `Response` will be created automatically 
based on what they return:

- if the value is `undefined`, empty `204 No Content` response will be created,
- if the value is a plain object (or `null`, or `toJSON` aware) it will 
  be `JSON.stringify`ed,
- everything else is cast to string (which invokes a `toString` method if available).

You can safely bypass this opinionated behavior by returning the `Response` instance
yourself.

```typescript
const app = demino();

// conveniently return plain object and have it be converted 
// to a Response instance automatically
app.get("/", () => ({ this: 'will', be: 'JSON stringified'}));

// or return any other type with a `toString` method
class MyRenderer {
    constructor(private data) {...}
    toString() { return `...`; }
}
app.get('/templated', (_r, _i, c) => new MyRenderer(c.locals))

// or you have a full control by returning the Response instance directly
app.get('/manual', () => new Response('This will be sent as is.'))
```

The route handler/middleware has the following signature:
```typescript
function handler(req: Request, info: Deno.ServeHandlerInfo, context: DeminoContext): any;
```

Middlewares can be registered globally per instance, or locally per route handler. 
Note that globals must be registered _before_ the route handler is declared to take effect.

```typescript
// OK
app.use(someGlobalMiddleware);
app.get("/secret", authCheckMiddleware, handler);

// NOT OK, the `someGlobalMiddleware` will not be used for the `/secret` route
app.get("/secret", authCheckMiddleware, handler);
app.use(someGlobalMiddleware);
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

## The Express-like semantics

Demino uses the http method name route handler convention. 

```typescript
app.get('/resources/[id]', readResourceHandler);
app.post('/resources', createResourceHandler);
// app.delete, app.patch, app.put, app.head...
```

Also, the middlewares usage is similar to Express:

```typescript
app.use(someMidlleware);
app.get('/foo', mid1, mid2, [mid3, mid4], handler);
```

One major difference from Express is the format of the route params in the default router. 
Express uses `/:param` while Demino uses `/[param]` placeholders. Read more on the custom
routers below.

## Apps composition

Multiple Demino apps can be composed into a single app. 
This is useful if you want to logically group certain mount paths with the same middlewares. 
For example:

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

Consider them proof of concept rather than battle-tested implementations.

### Express-like router

```ts
const app = demino("", [], { routerFactory: () => new DeminoExpressLikeRouter() });

app.get("/", () => "home");

app.get("/user/:foo/section/:bar", (_r, _i, ctx) => ctx.params);
```

Also available: [`DeminoFixedRouter`](./src/router/fixed-router.ts),
[`DeminoRegexRouter`](./src/router/regex-router.ts).

### Integrating a 3rd party routing library

Demino app expects a `DeminoRouter` interface (2 methods), where you can implement the 
actual integration.

```ts
class Some3rdPartyRouter extends DeminoRouter {
    /** Defines a callback to be executed on a given route match. */
    on(route: string, callback: DeminoRouterOnMatch): void {
        // you need to save the route+callback pairs somewhere...
    }
    /** Executes pathname match lookup against the registered routes. */
    exec(pathname: string): null | DeminoRouterOnMatchResult {
        // if pathname is matched, call the saved callback with parsed params (if any)
        // as its only argument
    }
}

const app = demino("", [], { routerFactory: () => new Some3rdPartyRouter() });
```

## Extra: file based routing

Work in progress...

