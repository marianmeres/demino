# @marianmeres/demino

[![JSR](https://jsr.io/badges/@marianmeres/demino)](https://jsr.io/@marianmeres/demino)

"Demino" (Deno minimal) is a minimalistic web server framework built on top of the 
Deno's built-in HTTP server, providing:

- [routing](https://github.com/marianmeres/simple-router), 
- [middlewares support](https://github.com/marianmeres/midware),
- unified error handling,
- express-like semantics.

## Installation

```sh
deno add jsr:@marianmeres/demino
```

## Basic usage

```ts
import { demino } from "@marianmeres/demino";

const app = demino();
app.get("/", () => "Hello, World!");

// `demino` app is a `Deno.serve` handler
Deno.serve(app);
```

## Routing and mount path prefix

Every Demino app can be mounted to a specific route prefix (called the `mountPath`). Default `mountPath` is an empty string (a.k.a. the server root). The final route endpoint is evaluated as a `mountPath + route`.

```typescript
// in the example below the final route endpoint will be `/api/users/[userId]`
const api = demino("/api");
api.get("/users/[userId]", (req, info, ctx) => Users.find(ctx.params.userId));
```

Every final route endpoint (that is `mountPath + route`) must begin with a slash `/`. For the router details see [the router docs](https://github.com/marianmeres/simple-router), but you get the idea here:

```typescript
app.get('/fixed/path', ...);
app.get('/named/[segment]/etc', ...);
app.get('/named/and/regexed/[segment([0-9]+)]', ...);
app.get('/optional/[segment]?', ...);
app.get('/[...segment]/etc', ...); // multiple "rest" segments
```

## Route handlers and middlewares

The stuff happens in route handlers. Or in middlewares. Or in both. In fact, 
they are technically the same thing - the route handler is just the final middleware in the middlewares collection (which is executed serially).

Having said that, they are still expected to behave a little differently. Middlewares 
typically _do_ something (eg validate), while route handlers typically _return_ something (eg html string or json objects).

As soon as any middleware decides to _return_ a thing, the whole execution chain is 
terminated and a response is sent immediately.

```typescript
const api = demino("/api");

// make sure all `/api` endpoints send json content type headers
api.use((_req, _info, ctx) => {
    ctx.headers.set("Content-Type", "application/json");
});
```

Signature of the route handler/middleware is:
```typescript
function handler(req: Request, info: Deno.ServeHandlerInfo, context: DeminoContext): any;
```

Middlewares can be registered globally per app (via `use`), or locally per route handler as in the example below:

```typescript
app.get("/secret", authCheckMiddleware, handler);
```


## Context

As shown above, each middleware receives a `context` parameter, which is just a plain object which visibility and lifetime is limited to the scope 
and lifetime of the Deno's request handler. 

It has few "system" props (eg `params` and `headers`) as well as the `locals` prop where each middleware can read and write arbitrary data.

```typescript
const app = demino('/articles');

// example middleware loading some article data...
app.use(async (_req, _info, ctx) => {
    if (ctx.params.articleId) {
        ctx.locals.article = await Article.find(ctx.params.articleId);
        if (!ctx.locals.article) {
            throw new ArticleNotFound(`Article ${ctx.params.articleId} not found`);
        }
    }
})

// and route handler just rendering the html...
app.get("/[articleId]", (_req, _info, ctx) => render(ctx.locals.article));
```

## Error handling

Every error thrown anywhere is caught and passed to the error handler. The built-in error handler can be customized via the `app.error(handler)`.

```typescript
// customized json reponse error handler 
app.error((_req, _info, error, headers) => {
    headers.set("Content-Type", "application/json");
    return new Response(
        JSON.stringify({ ok: false, message: error.message }),
        { status: error?.status || 500, headers }
    );
});
```

## Composition of Demino apps

Multiple Demino apps can be composed into a single app. 
This is mainly useful if you want to logically group certain mount paths with the same middlewares. For example:

```typescript
import { demino, deminoCompose } from "@marianmeres/demino";

// landing page example
const home = demino();
home.get("/", () => "Hello");
home.get("/[slug]", (_r, _i, ctx) => `Marketing: ${ctx.params.slug}`);

// api example
const api = demino("/api", (_r, _i, ctx) => {
    ctx.headers.set("Content-Type", "application/json; charset=utf-8");
});
api.get("/[entity]", (_r, _i, ctx) => ({ entity: ctx.params.entity }));

// etc...
const blog = demino("/blog");
blog.get("/[slug]", (_r, _i, ctx) => `Blog: ${ctx.params.slug}`);

// compose all together, and serve as a one handler
Deno.serve(deminoCompose([home, api, blog]));
```