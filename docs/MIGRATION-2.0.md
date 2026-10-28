# Migrating to Demino 2.0

Demino 2.0 decouples the core from Deno. The library is web standards plus the `node:*`
subset, servers start through a runtime adapter (`@marianmeres/demino/deno`, `/node`),
and the package is published to JSR **and** npm (Node 22+). Routing, middlewares, the context,
error handling, composition and the loggers are unchanged.

For a typical 1.x Deno app the whole migration is:

1. one `sed` over type annotations (`Deno.ServeHandlerInfo` → `DeminoServeInfo`, [item 1](#1-handler-info-type)),
2. a look at the options you pass to `app.static`, if any ([item 3](#3-appstatic-options)),
3. optionally, starting the server through the adapter instead of `Deno.serve(app)` - required
   only for WebSocket tunneling through `proxy()` ([item 2](#2-demino-no-longer-extends-denoservehandler)).

`Deno.serve(app)` keeps compiling and running. The ten items below are the complete list of
what a consumer can observe; items 1-5 may need an edit, 6-10 only matter in the situation
they name.

## 1. Handler info type

`Deno.ServeHandlerInfo` is gone from every Demino signature. The second argument of a
middleware or route handler is now a `DeminoServeInfo`:

```ts
interface DeminoServeInfo {
	remoteAddr?: { hostname: string; port: number; transport?: string }; // DeminoRemoteAddr
	upgradeWebSocket?: (
		req: Request,
		options?: { protocol?: string; idleTimeout?: number },
	) => { socket: WebSocket; response: Response }; // DeminoUpgradeWebSocket
	raw?: unknown; // the runtime's own per-request object
}
```

Type-only: at runtime Deno's own info object already satisfies it (`remoteAddr`), and the
adapters fill in the rest. Rename the annotations in place:

```sh
# macOS (BSD sed)
grep -rl 'Deno\.ServeHandlerInfo' src | xargs sed -i '' 's/Deno\.ServeHandlerInfo/DeminoServeInfo/g'
# Linux (GNU sed)
grep -rl 'Deno\.ServeHandlerInfo' src | xargs sed -i 's/Deno\.ServeHandlerInfo/DeminoServeInfo/g'
```

(`src` is wherever your handlers live.) `DeminoServeInfo` is not a global the way `Deno.*`
was, so every file that now names it needs the import: add `type DeminoServeInfo` to the
file's existing import from `@marianmeres/demino`, or add one:

```ts
import type { DeminoContext, DeminoServeInfo } from "@marianmeres/demino";

app.use(async (req: Request, info: DeminoServeInfo, ctx: DeminoContext) => {
	// ...
});
```

Or drop the annotations: for handlers written inline in `app.get(...)` / `app.use(...)` all
three parameter types are inferred.

Less common, also type-only: a handler you typed as `Deno.ServeHandler` is a
`DeminoServeHandler`; `info.remoteAddr` is a `DeminoRemoteAddr` (was `Deno.NetAddr`).
Anything Deno-specific you read off `info` (e.g. `info.completed`) is at `info.raw` when the
app runs through the Deno adapter, and still directly on `info` under a bare
`Deno.serve(app)` - cast as needed.

## 2. `Demino` no longer extends `Deno.ServeHandler`

The app type is now a plain call signature, `(req: Request, info?: DeminoServeInfo) =>
Promise<Response>`, structurally compatible with what `Deno.serve()` expects. Both of these
still compile and run:

```ts
Deno.serve(app);
Deno.serve({ port: 3000, onListen: logListenInfo }, app);
```

Under a bare `Deno.serve`, `info` carries `remoteAddr` only, so everything except WebSocket
tunneling ([item 6](#6-proxy-websocket-tunneling-needs-an-adapter)) behaves exactly as in
1.x. The adapter is the recommended form: the same call on every runtime, a `ServeHandle`
back, and the upgrade capability on `info`:

```ts
import { serve } from "@marianmeres/demino/deno"; // or "/node"

const server = await serve(app, { port: 3000 }); // onListen defaults to logListenInfo
server.url; // "http://localhost:3000/"
await server.shutdown();
```

Differences from `Deno.serve` worth knowing: `serve()` returns a `Promise`; `shutdown()` is
graceful while aborting `signal` closes every connection at once; the options are `port`,
`hostname`, `signal`, `onListen`, `onError` (and `webSockets` on Node) - no TLS, no
`reusePort`. If you need those, keep `Deno.serve` and hand over the upgrade capability
yourself; per request this is all the Deno adapter does:

```ts
Deno.serve(tlsOptions, (req, info) =>
	app(req, { remoteAddr: info.remoteAddr, upgradeWebSocket: Deno.upgradeWebSocket, raw: info }));
```

## 3. `app.static` options

`app.static(route, fsRoot, options?)` is now Demino's own `serveStatic()` on `node:fs`
instead of `@std/http`'s `serveDir`, so the options are `DeminoStaticOptions`, not
`ServeDirOptions`:

| 1.x (`ServeDirOptions`)               | 2.0 (`DeminoStaticOptions`)                                                   |
| ------------------------------------- | ----------------------------------------------------------------------------- |
| `showIndex` (default `true`)          | same                                                                          |
| `showDotfiles` (default `false`)      | same                                                                          |
| `headers: string[]` (`"name: value"`) | `headers: HeadersInit \| (req, filePath) => HeadersInit` - on 200/206/304 only |
| `etagAlgorithm`                       | `etag: boolean` (default `true`); the algorithm is fixed                      |
| `enableCors`                          | removed - mount `cors()` on the route                                         |
| `quiet`                               | removed - nothing is logged                                                   |
| `showDirListing`                      | removed - a directory without `index.html` is a 404                           |

A type error points you at each use. Two common 1.x patterns:

```ts
// 1.x: CORS through the static options
app.static("/files", dir, { enableCors: true, quiet: true });

// 2.0: CORS is a middleware on the mount
app.use("/files", cors());
app.static("/files", dir);
```

```ts
// 1.x: a wrapper around serveDir that re-built the Response to add Cache-Control
// 2.0: the headers option, per request
app.static("/", "./build", {
	headers: (req) => ({ "cache-control": cacheControlFor(new URL(req.url).pathname) }),
});
```

Observable behaviour changes - no action needed, listed for tests that pin them: `ETag`
values change once (weak `W/"<size>-<mtime>"`, hex); the 301 to the normalised path carries a
relative `Location`; malformed percent-encoding is a 400; methods other than `GET`/`HEAD`
are a 405 with `Allow: GET, HEAD`; content types come from `mrmime`, with `; charset=utf-8`
on text-like types. `serveStatic(req, { fsRoot, urlRoot?, ...options })` is exported for use
under your own routes. Details in [API.md](../API.md#static-files).

## 4. `deminoFileBased` missing root

A missing routes directory used to throw `Deno.errors.NotFound`. It now throws a plain
`Error` with `code: "ENOENT"` and `name: "NotFound"` - the Node-style contract, the same on
every runtime. Match on `code`:

```ts
// 1.x
} catch (e) {
	if (e instanceof Deno.errors.NotFound) { /* ... */ }
}

// 2.0
} catch (e) {
	if ((e as { code?: string }).code === "ENOENT") { /* ... */ }
}
```

The `ignoreMissingRootDir` option is unchanged (a missing root is then skipped with a
warning instead of throwing).

## 5. `logListenInfo(addr)`

`logListenInfo` and the callback returned by `createLogListenInfo` take a `DeminoListenAddr`
(`{ hostname: string; port: number }`) instead of `Deno.NetAddr`. `Deno.serve`'s `onListen`
argument satisfies it, so `Deno.serve({ onListen: logListenInfo }, app)` is unchanged; only
a callback you annotated with `Deno.NetAddr` yourself needs the type renamed. Every adapter
uses `logListenInfo` as its default `onListen`, so through `serve()` you pass nothing.

## 6. Proxy WebSocket tunneling needs an adapter

`proxy()` tunnels WebSocket upgrades through `info.upgradeWebSocket`, which only the adapters
provide. Under a bare `Deno.serve(app)` an upgrade request falls through to the plain HTTP
proxy path and the app logger warns once:

```
[proxy] WebSocket tunneling needs a runtime adapter (`info.upgradeWebSocket` is missing) - forwarding the upgrade request as plain HTTP. Start the app through @marianmeres/demino/deno or /node to enable tunnels.
```

Start the app through the adapter's `serve()` ([item 2](#2-demino-no-longer-extends-denoservehandler)).
On Node also install `ws` ([item 8](#8-dependencies)).

## 7. Bun is not a supported runtime

Bun is not a supported runtime. A demino app is a web-standard handler, so
`Bun.serve({ fetch: app })` serves plain HTTP; `ctx.ip` from the socket and WebSocket
tunneling are not available there, and nothing is tested on Bun.

## 8. Dependencies

Removed: every `@std/*` dependency (`@std/http`, `@std/fs`, `@std/path`, `@std/fmt`,
`@std/assert`) and `request-ip`. Added: `mrmime` (content types for static files). Optional:
`ws` on Node, imported lazily by the Node adapter for WebSocket upgrades - without it the
Node adapter serves plain HTTP and warns once (`webSockets: false` opts out silently). On
Deno nothing is optional; `ws` is never loaded there.

## 9. Package exports and the npm package

| Specifier                        | Contents                                              |
| -------------------------------- | ----------------------------------------------------- |
| `@marianmeres/demino`            | everything (core, middlewares, routers, static, utils) |
| `@marianmeres/demino/deno`       | `serve()` for Deno                                     |
| `@marianmeres/demino/node`       | `serve()` for Node (`node:http` bridge, optional `ws`) |
| `@marianmeres/demino/middleware` | the bundled middlewares only                           |
| `@marianmeres/demino/misc`       | `deminoCompose`, `deminoFileBased`                     |
| `@marianmeres/demino/router`     | the routers                                            |
| `@marianmeres/demino/utils`      | `logListenInfo`, cookies, `withTimeout`, …             |

The root export is unchanged, so existing imports keep working. On Deno the subpaths resolve
through the one import-map entry `deno add jsr:@marianmeres/demino` writes (the same way
`@std/http/file-server` resolved through `@std/http`). The npm package
(`npm install @marianmeres/demino`) needs Node 22 or newer; `ws` is declared as an optional
peer.

## 10. Client-IP header precedence (unchanged)

The header list `ctx.ip` consults when `trustProxy` is on is the one `request-ip` 3.3.0 used,
now inlined as the exported `getClientIpFromHeaders(headers)`: `X-Client-IP`,
`X-Forwarded-For` (first valid token, left to right), `CF-Connecting-IP`, `Fastly-Client-IP`,
`True-Client-IP`, `X-Real-IP`, `X-Cluster-Client-IP`, `X-Forwarded`, `Forwarded-For`,
`X-Appengine-User-IP`, `Cf-Pseudo-IPv4`. The only drop is the RFC 7239 `Forwarded` header,
which `request-ip` accepted only when its whole value was a bare IP - a real
`Forwarded: for=…` value never matched, so nothing can have depended on it. The `trustProxy`
gating itself is as in 1.15+.

## Verifying the migration

```sh
grep -rn 'Deno\.ServeHandlerInfo\|Deno\.ServeHandler\b\|ServeDirOptions\|Deno\.errors\.NotFound' src
deno check src/server.ts   # or: npx tsc --noEmit
```

Then run your tests. Tests that exercise static files should expect the `ETag` and
`Location` differences from [item 3](#3-appstatic-options); nothing else is observable.
