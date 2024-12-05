# @marianmeres/demino

"demino" (deno minimal) - a tiny layer on top of `Deno.ServeHandler` providing 
[routing](https://github.com/marianmeres/simple-router), 
[middleware support](https://github.com/marianmeres/midware),
error handling 
and express-like semantics.

[![JSR](https://jsr.io/badges/@marianmeres/demino)](https://jsr.io/@marianmeres/demino)

## Installation

```sh
deno add jsr:@marianmeres/demino
```

## Basic usage

```ts
import { demino } from "@marianmeres/demino";

const app = demino();
app.get("/", () => "Hello, World!\n");

Deno.serve(app);
```
```sh
$ curl -i localhost:8000
HTTP/1.1 200 OK
Hello, World!
```
```sh
$ curl -i -X POST localhost:8000
HTTP/1.1 404 Not Found
Not Found
```
```sh
$ curl -i localhost:8000/foo
HTTP/1.1 404 Not Found
Not Found
```

## Route handler

Any valid `Deno.serve` handler as [described in the manual](https://docs.deno.com/runtime/fundamentals/http_server/) is a valid `demino` app route handler. In `demino` app, this handler receives one additional `DeminoContext` parameter, so it's signature is:

```ts
(req: Request, info: Deno.ServeHandlerInfo, context: DeminoContext) => any;
```

As a convenience, unlike for `Deno.serve`, the handler may return anything, not just the `Response` instance. If needed, it will be converted to a `Response` automatically.

## Midlewares

Middleware is a function, sync or async, which accepts one `DeminoContext` parameter. Middlewares is a collection of these functions which are executed in series before executing the final route handler.

Each middleware can throw or return `any`. If it returns anything other than `undefined`, the middlewares execution chain will be terminated and the returned value will be converted (if needed) to a `Response` immediately.

Middlewares can be passed globaly to app the instance, or individually to each route handler.

## Context

Context (`DeminoContext`) is a plain object which scope and lifetime is limited to the scope and lifetime of the request handler and which is passed as a reference to each middleware _and_ to the final route handler. 

It has few readonly "system" props (eg reference to the initial `request`, and parsed route named `params`) as well as the writable `locals` prop where each middleware can write arbitrary data to.

## Error handling

If an error is thrown anywhere (either during middlewares execution chain or in the final route handler), it is caught and passed to the error handler (either built-in or custom, if provided). The error handler's returned value is converted (if needed) to a `Response` immediately.

## Routes and mount path prefix

Every `demino` app instance can be "mounted" to a specific route prefix (called the `mountPath`). Default mount path is an empty string. The final route endpoint is evaluated as `mountPath + route`, so in the example below it will be `/api/users/[userId]`.

```ts
const api = demino("/api");
api.get("/users/[userId]", (req, info, ctx) => Users.find(ctx.params.userId))
```

Every final route (that is `mountPath + route`) must begin with a slash `/`. For the router details see [@marianmeres/simple-router](https://github.com/marianmeres/simple-router), but you get the idea here:

```ts
app.get('/fixed/path', ...);
app.get('/named/[segment]/etc', ...);
app.get('/named/and/regexed/[segment([0-9]+)]', ...);
app.get('/optional/[segment]?', ...);
app.get('/may-contain-slashes/[...segment]', ...);
```

The http query params are evaluated by the router as well. The named segments have priority over the query params. So, the `/named/[segment]` route, when requested as `/named/foo?bar=baz&segment=ignored` will be parsed and available in the context params as:
```ts
// context
{
    ...
    params: {
        segment: 'foo',
        bar: 'baz'
    }
}
```

## Composition of multipe demino apps

Multipe `demino` apps mounted on different mount paths can be composed into a single handler. For example:

```ts
import { demino, deminoCompose } from "@marianmeres/demino";

// landing page example
const home = demino();
home.get("/", () => "Hello");
home.get('/[slug]', (req, info, ctx) => Marketing.find(ctx.params.slug));

// api example using some auth middleware
const api = denimo('/api');
api.use((ctx) => {
    if (!hasValidToken(cts.request.headers)) {
        throw new Unauthorized('Boo');
    }
})
api.get("/version", () => "1.0.0");

// etc...
const blog = denimo('/blog');
api.get('/[slug]', (req, info, ctx) => Blog.find(ctx.params.slug));

// compose all together, and serve as a one handler
Deno.serve(deminoCompose([home, api, blog]));
```