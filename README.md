# @marianmeres/demino

[![JSR](https://jsr.io/badges/@marianmeres/demino)](https://jsr.io/@marianmeres/demino)

"Demino" (Deno minimal) is a minimalistic web server framework built on top of the 
Deno's built-in HTTP server. 

It provides:

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

// create the Demino app instance
const app = demino();

// register method and route handlers...
app.get("/", () => "Hello, World!");

// serve (`demino` app is a `Deno.serve` handler)
Deno.serve(app);
```

## Routing and mount path

Route is a string representing the pathname segment of the url of the incoming request.

Every Demino app can be mounted to a specific route prefix (called the `mountPath`). Default `mountPath` is an empty string (the server root). The final route endpoint is evaluated as a `mountPath + route`.

The usage is `app[httpMethodVerb](route, [middlewares,] handler)`.

```typescript
// create a Demino with a `/api` mount path
const api = demino("/api");

// this example will handle `HTTP GET /api/users/user-id`
api.get("/users/[userId]", (req, info, ctx) => Users.find(ctx.params.userId));
```

For more router details see [the router docs](https://github.com/marianmeres/simple-router), but you get the idea here:

```typescript
app.get('/fixed/path', ...);
app.get('/named/[segment]/etc', ...);
app.get('/named/and/regexed/[segment([0-9]+)]', ...);
app.get('/optional/[segment]?', ...);
app.get('/[...segment]/etc', ...); // multiple "rest" segments
```

If multiple routes of the same method and endpoint are registered, the first one
always wins.

## Route handlers and middlewares

The stuff happens in route handlers. Or in middlewares. Or in both. In fact, 
they are technically the same thing - the route handler is just the final middleware in the internal middlewares collection.

Having said that, they are still expected to behave a little differently. Middlewares 
mainly _do_ something (eg validate), while route handlers mainly _return_ something (eg html string or json objects).

As soon as any middleware decides to _return_ a thing, the whole middlewares 
execution chain is terminated and a response is sent immediately.

Unlike in `Deno.serve` handlers, the Demino route handlers are not required to return
a `Response` instance. If they don't, the `Response` will be created automatically 
based on their return type:

- if the value is `undefined`, empty `204 No Content` response will be created,
- if the value is a plain object (or `null`, or object with a `.toJSON` method) it will be `JSON.stringify`-ed,
- everything else will be casted to string (which automatically triggers a `toString` method if available).

You can safely bypass this opinion by returning the `Response` instance
yourself.

```typescript
const api = demino("/api");

// make sure all `/api` endpoints send json content-type headers
api.use((_req, _info, ctx) => {
    ctx.headers.set("Content-Type", "application/json");
});

// conveniently return objects directly
api.get("/", () => ({ this: 'will', be: 'JSON stringified'}));
```

The route handler/middleware has the following signature:
```typescript
function handler(req: Request, info: Deno.ServeHandlerInfo, context: DeminoContext): any;
```

Middlewares can be registered globally per app (via `use`), or locally per route handler.

```typescript
app.use(someGlobalMiddleware);
app.get("/secret", authCheckMiddleware, handler);
```


## Context

Each middleware receives a `context` object which visibility and lifetime is limited to the scope and lifetime of the Deno's request handler. 

It has few "system" props (eg `params` and `headers`) as well as the `locals` prop where each middleware can read and write arbitrary data.

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

// and route handler acting as a pure renderer. This handler will not be reached
// if the article is not found
app.get("/[articleId]", (_req, _info, ctx) => render(ctx.locals.article));
```

## The express-like semantics

Demino uses the http method name route handler convention. 

```typescript
const app = demino();

app.get('/resources/[id]', readResourceHandler);
app.post('/resources', createResourceHandler);
// app.delete, app.patch, app.put, ...
```

Also, the middlewares usage is similar to express:

```typescript
const app = demino();

app.use(someMidlleware);

app.get('/foo', mid1, mid2, [mid3, mid4], handler);
```

## Error handling

Errors are caught and passed to the error handler. The built-in error handler can be customized via the `app.error(handler)` interface.

```typescript
// example: customized json response error handler 
app.error((_req, _info, ctx) => {
    headers.set("Content-Type", "application/json");
    const error = ctx.error;
    return new Response(
        JSON.stringify({ ok: false, message: error.message }),
        { status: error?.status || 500, headers }
    );
});
```

## Composition of Demino apps

Multiple Demino apps can be composed into a single app. 
This is useful if you want to logically group certain mount paths with the same middlewares. For example:

```typescript
import { demino, deminoCompose } from "@marianmeres/demino";

// landing page example
const home = demino();
home.get("/", () => "Hello");
home.get("/[slug]", (_r, _i, ctx) => `Marketing: ${ctx.params.slug}`);

// api example (note that middlewares can be added via factory as well)
const api = demino("/api", addJsonHeader);
api.use(validateBearerToken);
api.get("/[entity]", (_r, _i, ctx) => ({ entity: ctx.params.entity }));


// compose all together, and serve as a one handler
Deno.serve(deminoCompose([home, api]));
```

The same effect can be, of course, achieved without the composition like this:

```typescript
const app = demino();

// home
app.get("/", ...);
app.get("/[slug]", ...);

// api
app.get("/api/[entity]", addJsonHeader, validateBearerToken, ...);

Deno.serve(app);
```