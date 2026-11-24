# Changelog

The changes that alter behavior or break something, newest first. Everything else is in the
[commit history](https://github.com/marianmeres/demino/commits/master).

## 2.1.2 (fixes)

### Node adapter: a client that leaves early no longer leaks a file descriptor

When a client disconnected before the handler had returned, the Node adapter
(`@marianmeres/demino/node`) dropped the response body without cancelling it. Behind a static
file of about 128 KB or more that left a file descriptor open for good, one per such request,
until the process ran out of them. Any client could trigger it by sending a request and closing
the connection at once. Affected: 2.0.0 to 2.1.1 on the Node adapter (a streamed body of any
other kind was left uncancelled the same way). Now a body is always either read to its end or
cancelled.

### Static files

- A file that exists but cannot be read (`EACCES`) is a thrown error: it reaches your error
  handler and the log, as a 500 by default. It used to be an empty reply with nothing logged.
- The body is exactly `Content-Length` bytes of the file the headers describe. A file that
  grows while it is being served is not sent past them (extra bytes used to follow). One that
  is truncated, or replaced by another file before the first byte is read, ends the response at
  once (it used to stall until the keep-alive timeout).
- `If-Range` is honoured: a `Range` request whose `If-Range` date does not equal the file's
  `Last-Modified` gets the whole file with a 200, not a 206. An entity-tag in `If-Range` never
  matches, because the `ETag`s are weak.
- The 301 to a normalised path percent-encodes its `Location`. For a file name containing `%`
  it used to point at a URL that answered 400, or at another file.
- A path with an encoded backslash or NUL is a 404 before any redirect (`/a//b%5Cc` used to be
  a 301 first).

## 2.1.0 (behavior changes)

### `ctx.headers` reach a returned `Response`

Before 2.1.0, a `Response` instance returned by a handler or by a custom error handler was
sent without the headers set on `ctx.headers`. Now they are added to it, where the response
does not carry them already (`Set-Cookie` and `Vary` are merged) - see
[Response headers](README.md#response-headers-ctxheaders). What changes in practice:

- `cors()` covers `app.static()`, `proxy()` and any route returning a `Response`,
- a cookie set through `cookies()` survives a `redirect()`,
- `Retry-After` (from `rateLimit()`) and `Allow` (on a `405`) reach a custom error handler's
  `Response`.

A returned `Response` that has a body gets the headers added to the object itself. One with
no body is copied first, so an instance shared between requests is never written to.

### `X-Powered-By` and `X-Response-Time` are on every response

They were set only on the responses Demino created. Now a returned `Response` gets them too
(static files, proxied responses, redirects), unless it carries its own. The `noXPoweredBy`
and `noXResponseTime` options turn them off as before.

## 2.0.0 (breaking changes)

Demino 2.0 decouples the core from Deno: web standards plus `node:*` inside, runtime
adapters (`@marianmeres/demino/deno`, `/node`) to start the server, published to JSR
**and** npm. Routing, middlewares, context, error handling and composition are untouched. The
complete list with before/after snippets is in
[docs/MIGRATION-2.0.md](docs/MIGRATION-2.0.md); for a typical Deno app the migration is one
`sed` and a look at your `app.static` options.

### `Deno.ServeHandlerInfo` → `DeminoServeInfo`

The handler's second argument is typed `DeminoServeInfo` (`remoteAddr?`,
`upgradeWebSocket?`, `raw?`) - type-only, Deno's own info object satisfies it. Rename the
annotations and add the import where a file now names the type (or drop the annotations,
inline handlers are inferred):

```sh
# macOS (BSD sed); on Linux use `sed -i` without the ''
grep -rl --include='*.ts' --exclude-dir=node_modules 'Deno\.ServeHandlerInfo' src | xargs sed -i '' 's/Deno\.ServeHandlerInfo/DeminoServeInfo/g'
```

### `Demino` no longer extends `Deno.ServeHandler`

Structural compatibility with `Deno.serve`'s TCP handler is kept, so `Deno.serve(app)`
compiles and runs; `info` then carries `remoteAddr` only. A parameter typed as the bare
`Deno.ServeHandler` (which also admits Unix and Vsock addresses) no longer accepts an app -
narrow it to `Deno.ServeHandler<Deno.NetAddr>`. Prefer `serve()` from an adapter
([Runtimes](README.md#runtimes)) for WebSocket tunneling through `proxy()`.

### `app.static` options are `DeminoStaticOptions`

Own `serveStatic()` on `node:fs` replaces `@std/http`'s `serveDir`. Kept: `showIndex`,
`showDotfiles`; `headers` is now `HeadersInit` or a per-request function; `etagAlgorithm`
became `etag: boolean`. Removed: `enableCors` (set `access-control-allow-origin` through
`headers`), `quiet`, `showDirListing`. `ETag` values change once; static 301s send a relative
`Location`. See [Serving static files](README.md#serving-static-files).

### Smaller changes

- `deminoFileBased` with a missing root throws a plain `Error` with `code: "ENOENT"` and
  `name: "NotFound"` (was `Deno.errors.NotFound`) - match on `code`.
- `logListenInfo(addr)` takes `{ hostname, port }` (`DeminoListenAddr`, was `Deno.NetAddr`);
  Deno's `onListen` argument still satisfies it.
- Dependencies: `@std/*` and `request-ip` removed, `mrmime` added, `ws` an optional peer for
  WebSocket upgrades on Node. The client-IP header precedence behind `trustProxy` is unchanged
  (the never-matching RFC 7239 `Forwarded` aside) and exported as `getClientIpFromHeaders()`.
- Exports: `.`, `./deno`, `./node`, `./middleware`, `./misc`, `./router`, `./utils`;
  the npm package needs Node 22+.

## 1.17.0 (behavior changes)

### `proxy()` tunnels WebSocket upgrade requests

A well-formed WebSocket upgrade request is tunneled to the upstream (on by default,
`webSockets: false` to disable). Before, it was forwarded as a plain `GET` that could never be
upgraded.

### `proxy()` re-validates upstream redirects

Upstream redirects are followed manually and every hop is re-checked against the SSRF /
`allowedHosts` policy, bounded by the new `maxRedirects` option (default 5). See
[Proxy](README.md#proxy).

## 1.15.0 (breaking changes)

### `ctx.ip` is now gated by `trustProxy`

`ctx.ip` previously trusted `X-Forwarded-For` / `X-Real-IP` / `CF-Connecting-IP`
**unconditionally**, which is spoofable by any client that can reach the origin without
going through the proxy. Now `ctx.ip` follows
[`trustProxy`](README.md#extra-behind-a-reverse-proxy-trustproxy-ctxurl): with it **off**
(default) it is the direct socket peer and those headers are ignored; with it **on** it
is resolved from them (unchanged from before). If your app sits behind a proxy and reads
`ctx.ip` (or keys `rateLimit()` on it), set `trustProxy` to keep seeing the real client
IP. This is the secure default and matches how `ctx.url` treats forwarded headers.

> Same-origin `redirect()` / `trailingSlash()` `Location` headers are now **relative**
> instead of absolute (functionally equivalent for clients). Only relevant if you assert
> an exact absolute `Location` in tests.

## 1.8.8 (behavior change)

### Catch-all (`*`) routes are consistently last

Earlier versions let a method-specific catch-all (e.g. `app.get("*")`) shadow
`app.all("/files/*")` and similar literal routes. Catch-alls are now consistently last. A `*`
registered on any single method no longer turns an otherwise-unmatched `HEAD` request into a
`405`. See [Catch-all precedence](README.md#catch-all--precedence).

## 1.7.0 (breaking changes)

This release changes a handful of defaults and internal APIs to fix correctness and
security issues. Most apps won't need any code changes — the affected areas are listed
below in order of likely impact.

### CORS — `allowCredentials` defaults to `false`

`cors()` previously defaulted `allowCredentials: true` while also defaulting
`allowOrigin: "*"`. The CORS spec forbids that combination, so the middleware silently
rewrote the wildcard to the request's `Origin` header — effectively allowing credentialed
requests from **any** origin out of the box.

Now:

- The default is `allowCredentials: false`.
- Constructing `cors({ allowOrigin: "*", allowCredentials: true })` throws a `TypeError`.
- If a dynamic `allowOrigin` function returns `"*"` while credentials are enabled, the
  middleware refuses to set the headers (and logs a warning) instead of echoing back the
  request origin.

**Migration:** to allow credentials, pass an explicit allowlist:

```ts
// before (1.6.x — silently insecure)
app.use(cors());

// after (1.7.0)
app.use(
	cors({
		allowOrigin: ["https://app.example.com", "https://admin.example.com"],
		allowCredentials: true,
	}),
);
```

### Default logger now emits access logs

Previously the default logger was `console as DeminoLogger`, but `console` has no `access`
method, so access logs were silently swallowed unless you supplied a custom logger. The
default adapter now wires `access` to `console.log` (prefixed with `[access]`).

**Migration:** if you relied on the previous "silent default" behavior, set the logger to
`null` (`app.logger(null)`) or supply a logger whose `access` method is a no-op.

### `withTimeout()` passes an `AbortSignal` to the wrapped function

`withTimeout(fn)` now invokes `fn(...args, signal)`, so functions can actually cancel
their work on timeout instead of having it run to completion in the background. Functions
that don't accept the extra argument simply ignore it, but TypeScript will surface the
extra positional parameter — update signatures to `(...args, signal?: AbortSignal)` if the
additional argument matters to your callers.

### SSRF protection covers more cases

`isPrivateHost()` (used by `proxy({ preventSSRF: true })`) now also detects:

- `0.0.0.0` and `::` (unspecified addresses)
- IPv4-mapped IPv6 (`::ffff:127.0.0.1`)
- CGNAT range `100.64.0.0/10`
- Bracketed IPv6 hostnames (`[::1]`)

If you have tests that asserted `isPrivateHost("0.0.0.0") === false`, they now return
`true`. There is no DNS resolution, so DNS-rebinding attacks are still possible — see the
caveat in the [Proxy section](README.md#proxy).

### ETag middleware skips bodies larger than 1 MiB by default

`withETag(handler)` used to buffer the entire response body to compute a SHA-1 hash with
no size limit. It now defaults to `maxSizeBytes: 1_048_576` (1 MiB) and returns the
response unchanged (no ETag, no 304 negotiation) when the body is larger.

**Migration:** if you knowingly need ETags on larger payloads, raise the cap:
`withETag(handler, { maxSizeBytes: 10 * 1024 * 1024 })`. Pass `0` or `Infinity` to disable
the cap entirely.

### Internal: per-(method, route) middleware stack is cached

The assembled `Midware` for each `(method, route)` is now cached and reused across
requests. The cache is invalidated whenever `app.use(...)` mutates the global stacks or a
route is registered. This is a transparent perf change — no API change — but if you were
relying on a per-request side effect inside the array assembly, that's no longer
happening.
