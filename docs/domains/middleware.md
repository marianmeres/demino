# Middleware

## Overview

Demino includes several built-in middleware factories. Each returns a `DeminoHandler` that
can be registered via `app.use()` or as route-specific middleware.

## Key Files

| File                               | Purpose                    |
| ---------------------------------- | -------------------------- |
| `src/middleware/body-limit.ts`     | Request body size limit    |
| `src/middleware/cors.ts`           | CORS headers               |
| `src/middleware/cookies.ts`        | Cookie parsing/setting     |
| `src/middleware/proxy/proxy.ts`    | Request proxying           |
| `src/middleware/rate-limit.ts`     | Token bucket rate limiting |
| `src/middleware/etag.ts`           | ETag/304 responses         |
| `src/middleware/redirect.ts`       | URL redirects              |
| `src/middleware/trailing-slash.ts` | Slash normalization        |
| `src/middleware/authz.ts`          | Authorization gate + tools |

---

## cors

Creates CORS headers.

**Defaults (since 1.7.0):** `allowOrigin: "*"`, `allowCredentials: false`. Constructing
`cors({ allowOrigin: "*", allowCredentials: true })` throws `TypeError`. Dynamic
`allowOrigin` resolving to `"*"` while credentials are enabled refuses to set headers and
warns.

```ts
import { cors } from "@marianmeres/demino";

// Basic usage (no credentials)
app.use(cors());

// With options
app.use(cors({
	allowOrigin: "*", // string | string[] | fn
	allowMethods: ["GET", "POST"], // string[]
	allowHeaders: ["Content-Type"], // string[]
	allowCredentials: false, // boolean (default: false)
	maxAge: 86400, // number (seconds)
}));

// Credentialed: explicit allowlist required
app.use(cors({
	allowOrigin: ["https://app.example.com"],
	allowCredentials: true,
}));

// Dynamic origin
app.use(cors({
	allowOrigin: (origin, headers) => whitelist.includes(origin) ? origin : "",
}));

// Handle OPTIONS preflight
app.options("*", cors());
```

---

## cookies

Parses request cookies into `ctx.locals.cookies` and provides `setCookie`/`deleteCookie`
helpers.

```ts
import { cookies } from "@marianmeres/demino";

// With default options for all cookies
app.use(cookies({ httpOnly: true, secure: true, sameSite: "Lax", path: "/" }));

app.get("/", (req, info, ctx) => {
	// Read
	const sessionId = ctx.locals.cookies.session;

	// Set (defaults applied)
	ctx.locals.setCookie("session", "abc123", { maxAge: 3600 });

	// Delete
	ctx.locals.deleteCookie("session");
});
```

**Options**: `httpOnly`, `secure`, `sameSite`, `path`, `domain`, `maxAge`, `expires`

---

## proxy

Proxies requests to another server. Supports SSRF protection, host whitelisting, and
transformations.

```ts
import { proxy } from "@marianmeres/demino";

// Basic: wildcard replacement
app.get("/api/*", proxy("https://backend/*"));

// Function target
app.get("/search/[q]", proxy((req, ctx) => `https://api.example.com/?q=${ctx.params.q}`));

// With options
app.get(
	"/api/*",
	proxy("https://backend/*", {
		preventSSRF: true, // Block private IPs (default: false)
		allowedHosts: ["*.example.com"], // Host whitelist
		timeout: 30000, // Request timeout (ms)
		transformRequestHeaders: (h) => h, // Modify outgoing headers
		transformResponseHeaders: (h, r) => h, // Modify response headers
		transformResponseBody: (b, r) => b, // Modify response body
		onError: (error, req, ctx) => {}, // Custom error handling
	}),
);
```

**`preventSSRF` covers** (since 1.7.0): localhost (`127.0.0.0/8`, `*.localhost`),
unspecified (`0.0.0.0`, `::`), private IPv4 (`10/8`, `100.64/10` CGNAT, `169.254/16`,
`172.16/12`, `192.168/16`), private IPv6 (`::1`, `fe80::/10`, `fc00::/7`), IPv4-mapped
IPv6 (`::ffff:1.2.3.4`), and bracketed IPv6 (`[::1]`).

**Caveat:** string-only check, no DNS lookup. DNS-rebinding bypasses this guard. For
DNS-rebinding-resistant SSRF, resolve via `Deno.resolveDns` and re-check each result.

> Does NOT support WebSockets.

---

## rateLimit

Token bucket rate limiting. Throws `429 Too Many Requests` when exceeded. In-memory only
(single-server setups).

```ts
import { rateLimit } from "@marianmeres/demino";

app.use(
	"/api",
	rateLimit(
		// Client ID function (return falsy to skip)
		(req, info, ctx) => req.headers.get("Authorization"),
		{
			maxSize: 20, // Bucket capacity / burst (default: 20)
			refillSizePerSecond: 10, // Tokens added per second (default: 10)
			cleanupProbability: 0.001, // Per-request GC chance (default: 0.001)
			getConsumeSize: (req, info, ctx) => 1, // Tokens per request (default: 1)
		},
	),
);
```

**Active client retention (since 1.7.0):** every request refreshes the entry's
`lastAccess` timestamp, so the periodic cleanup pass cannot evict a client that is still
being limited.

---

## bodyLimit

Rejects oversized requests before the body is read, guarding against memory exhaustion
from large uploads. Pure header gate — never consumes `req.body`, so it composes with
downstream body parsing / streaming.

```ts
import { bodyLimit } from "@marianmeres/demino";

// global form is `app.use(mw)` with NO route argument
app.use(bodyLimit({ maxSize: 20 * 1024 * 1024 })); // 20 MiB

// stricter per-route limit (strictest wins when layered)
app.post("/upload", bodyLimit({ maxSize: 5 * 1024 * 1024 }), handler);
```

Options: `maxSize` (bytes, required); `allowUnknownLength` (default `false`).

Behavior:

- `Content-Length` > `maxSize` → `413 Payload Too Large` (no bytes buffered).
- `Content-Length` ≤ `maxSize` → allowed; `Deno.serve` caps the read at the declared
  length, so a handler can never receive more than advertised (under-declaring cannot
  bypass the limit).
- Body present but no `Content-Length` (chunked) → `411 Length Required`, unless
  `allowUnknownLength: true` (then you must bound the stream yourself).
- No body → passes through.

Request-side defense in depth; pair with a reverse-proxy limit (e.g. nginx
`client_max_body_size`) in production.

---

## withETag

Wraps a handler to generate ETags and return `304 Not Modified` for cached content.

```ts
import { withETag } from "@marianmeres/demino";

app.get(
	"/api/data",
	withETag(async () => {
		return await fetchData();
	}),
);

// Weak ETag (faster, less precise)
app.get("/data", withETag(() => content, { weak: true }));

// Lift the size cap (default 1 MiB)
app.get("/large", withETag(handler, { maxSizeBytes: 10 * 1024 * 1024 }));

// Disable the cap entirely
app.get("/anything", withETag(handler, { maxSizeBytes: 0 }));
```

- Only processes GET/HEAD with 2xx responses
- Reads entire response body to compute hash
- Skips hashing for bodies above `maxSizeBytes` (default `1_048_576` since 1.7.0; pass `0`
  or `Infinity` to disable)

---

## redirect

Creates a redirect response.

```ts
import { redirect } from "@marianmeres/demino";

// Permanent redirect (301)
app.use("/old", redirect("/new", 301));

// Temporary redirect (302, default)
app.use("/temp", redirect("/other"));

// External URL
app.use("/external", redirect("https://example.com"));
```

---

## trailingSlash

Enforces or removes trailing slashes via redirect.

```ts
import { trailingSlash } from "@marianmeres/demino";

// Enforce trailing slash: /foo → /foo/
app.use(trailingSlash(true));

// Remove trailing slash: /foo/ → /foo
app.use(trailingSlash(false));
```

Returns `308 Permanent Redirect` when normalization needed.

---

## authz

Generic, policy-free authorization gate. Reads each route's declaration from
`ctx.routeMeta["authz"]` and enforces it via your opaque `check` callback. Demino has NO
rbac/policy dependency — wire `@marianmeres/rbac` (or anything) inside `check`.

Register it once, EARLY (right after any subject-resolving auth middleware). It runs in
normal registration order — it is NOT self-pinned to an early sort order — so it composes
with a preceding middleware that populates the subject.

```ts
import { Rbac } from "@marianmeres/rbac"; // the APP imports rbac, not demino
import { authz, withPermission, withPublic } from "@marianmeres/demino/middleware";

const rbac = new Rbac(); // ...roles/groups/rules...

app.use(authz({
	resolveSubject: (req) => verifyJwt(req.headers.get("authorization")),
	check: (subject, permission) => rbac.can(subject as any, permission),
}));

app.get("/health", withPublic(() => "ok"));
app.get(
	"/invoices/[id]",
	withPermission("invoice:read", (req, info, ctx) => {
		// reached only if check() returned true
	}),
);
```

**Key options:** `check` (required), `resolveSubject`, `resolve`, `subjectKey` (default
`"subject"`), `denyByDefault` (default `true`), `allowOptions` (default `true`).

**Per-request flow:** OPTIONS bypass → resolve subject if empty → deny-by-default when no
declaration (403) → `{ public: true }` allows → permission required but no subject (401) →
run `check` per permission (`every`/`some`) → fail (403).

**Companion helpers:**

| Symbol                                 | Purpose                                                      |
| -------------------------------------- | ------------------------------------------------------------ |
| `withPermission(perm, handler, opts?)` | Declare a route needs permission(s).                         |
| `withPublic(handler)`                  | Declare a route public.                                      |
| `getSubject<T>(ctx, key?)`             | Typed accessor for the stored subject.                       |
| `createRouteResolver(map)`             | Build a `(method, route) => decl` resolver from a route map. |
| `permissionMatrix(app, opts?)`         | Build-time coverage report over `app.routes()`.              |
| `assertCovered(app, opts?)`            | Throw listing routes MISSING a declaration (fail-closed CI). |

A runtime gate can't cover 404/405/static catch-alls, so assert coverage at build time
with `assertCovered(app)`. See [API.md](../../API.md#authz) for exact signatures,
`AuthzOptions`, `AuthzDecl`, and `AuthzMatrixRow`.

All symbols are exported from both `@marianmeres/demino` and
`@marianmeres/demino/middleware`.

---

## Business Rules

- Middleware factories return `DeminoHandler`, not direct handlers
- Return `undefined` to continue chain; return value to stop and respond
- Use `__midwarePreExecuteSortOrder` property to control execution order
- Use `__midwareDuplicable = true` to allow registering same middleware multiple times

## Integration Points

- All middleware integrates with `ctx.locals` for data sharing
- Error middleware can access `ctx.error` for error details
- Logger available via `ctx.getLogger()` in all middleware
