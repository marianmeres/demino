# @marianmeres/demino

"demino" (deno minimal) is a minimalistic framework built on top of the 
Deno's built-in HTTP server. `demino` app is a `Deno.serve` handler.

It is a tiny layer providing 
[routing](https://github.com/marianmeres/simple-router), 
[middleware support](https://github.com/marianmeres/midware),
error handling and express-like semantics.

[![JSR](https://jsr.io/badges/@marianmeres/demino)](https://jsr.io/@marianmeres/demino)

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
```sh
$ curl -i localhost:8000
HTTP/1.1 200 OK
Hello, World!

$ curl -i -X POST localhost:8000
HTTP/1.1 404 Not Found
Not Found

$ curl -i localhost:8000/foo
HTTP/1.1 404 Not Found
Not Found
```

## Documentation

First, the vocabulary. Deno's built in HTTP server uses one _serve handler_ while the
`demino` app uses many _route handlers_. In other words, the `demino` app is 
a Deno's _serve handler_ which has it's own _route handlers_.

### Route handler

Route handlers are where the stuff happens. The route handler signature is:

<!-- Route handlers are almost identical to `Deno.serve` handlers. In fact,
any valid `Deno.serve` handler as [described in the manual](https://docs.deno.com/runtime/fundamentals/http_server/) 
is technically a valid `demino` route handler. It doesn't work the other way around.

The difference is that in `demino` app the route handler receives one 
additional `DeminoContext` parameter, and unlike with `Deno.serve`, it may return anything, 
not just the `Response` instance. -->

```typescript
function handler(req: Request, info: Deno.ServeHandlerInfo, context: DeminoContext): any;
```

Typically, the route handler returns a `Response` instance, but it may, in fact, return
`any` value, which will be converted to a `Response` instance automatically.

### Midlewares

Middleware is a function, sync or async, which accepts one `DeminoContext` parameter. 
Middlewares are executed in series _before_ the final route handler.

If any of the middleware returns anything other than `undefined`, the execution chain will 
be terminated and a `Response` is sent immediately.

Middlewares can be passed to the `demino` app globaly, or individually to each route handler.

Todo: example

### Context

Context (`DeminoContext`) is a plain object which visibility and lifetime is limited to the scope 
and lifetime of the request handler. It is passed to each middleware _and_ to the final 
route handler. 

It has few readonly "system" props (eg reference to the initial `request`, and parsed route 
named `params`) as well as the writable `locals` prop where each middleware can read and 
write arbitrary data.

### Error handling

Every error thrown anywhere (either during middlewares execution chain or in the final route handler), 
is caught and passed to the error handler. The built-in error handler can be customized.

Todo: example

### Routes and mount path prefix

Every `demino` app can be "mounted" to a specific route prefix (called the `mountPath`). 
Default `mountPath` is an empty string (the server root). The final route endpoint is evaluated 
as `mountPath + route`.

```typescript
// in the example below the final route endpoint will be `/api/users/[userId]`
const api = demino("/api");
api.get("/users/[userId]", (req, info, ctx) => Users.find(ctx.params.userId))
```

Every final route endpoint (that is `mountPath + route`) must begin with a slash `/`. For 
the router details see [@marianmeres/simple-router](https://github.com/marianmeres/simple-router), 
but you get the idea here:

```typescript
app.get('/fixed/path', ...);
app.get('/named/[segment]/etc', ...);
app.get('/named/and/regexed/[segment([0-9]+)]', ...);
app.get('/optional/[segment]?', ...);
app.get('/[...segment]/etc', ...); // multiple "rest" segments
```

The route named segments and query params are parsed and collected together and are all 
visible under the `params` context key. 

Side note: the route named segments have priority over the query params. So, the `/named/[segment]` route, 
when requested as `/named/foo?bar=baz&segment=bat` will be parsed as:

```typescript
// context
{
    ...
    params: {
        segment: 'foo',
        bar: 'baz'
    }
}
```

### Composition of multipe `demino` apps

Multiple `demino` apps can be composed into a single app. 
This is mainly useful if you want to logically group certain mount paths with same middlewares
(or error handlers). For example:

```typescript
import { demino, deminoCompose } from "@marianmeres/demino";

// landing page example
const home = demino();
home.get("/", () => "Hello");
home.get('/[slug]', (req, info, ctx) => Marketing.find(ctx.params.slug));

// api example (using some auth middleware for illustration)
const api = demino('/api');
api.use((ctx) => {
    if (!hasValidToken(ctx.request.headers)) {
        throw new Error('Boo');
    }
})
api.get("/some", () => getSome());

// etc...
const blog = demino('/blog');
api.get('/[slug]', (req, info, ctx) => Blog.find(ctx.params.slug));

// compose all together, and serve as a one handler
Deno.serve(deminoCompose([home, api, blog]));
```