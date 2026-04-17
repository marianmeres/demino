# Middleware

## Overview

Demino includes several built-in middleware factories. Each returns a `DeminoHandler` that can be registered via `app.use()` or as route-specific middleware.

## Key Files

| File | Purpose |
|------|---------|
| `src/middleware/cors.ts` | CORS headers |
| `src/middleware/cookies.ts` | Cookie parsing/setting |
| `src/middleware/proxy/proxy.ts` | Request proxying |
| `src/middleware/rate-limit.ts` | Token bucket rate limiting |
| `src/middleware/etag.ts` | ETag/304 responses |
| `src/middleware/redirect.ts` | URL redirects |
| `src/middleware/trailing-slash.ts` | Slash normalization |

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
  allowOrigin: "*",                    // string | string[] | fn
  allowMethods: ["GET", "POST"],       // string[]
  allowHeaders: ["Content-Type"],      // string[]
  allowCredentials: false,             // boolean (default: false)
  maxAge: 86400,                       // number (seconds)
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

Parses request cookies into `ctx.locals.cookies` and provides `setCookie`/`deleteCookie` helpers.

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

Proxies requests to another server. Supports SSRF protection, host whitelisting, and transformations.

```ts
import { proxy } from "@marianmeres/demino";

// Basic: wildcard replacement
app.get("/api/*", proxy("https://backend/*"));

// Function target
app.get("/search/[q]", proxy((req, ctx) => `https://api.example.com/?q=${ctx.params.q}`));

// With options
app.get("/api/*", proxy("https://backend/*", {
  preventSSRF: true,              // Block private IPs (default: false)
  allowedHosts: ["*.example.com"], // Host whitelist
  timeout: 30000,                 // Request timeout (ms)
  transformRequestHeaders: (h) => h,    // Modify outgoing headers
  transformResponseHeaders: (h, r) => h, // Modify response headers
  transformResponseBody: (b, r) => b,    // Modify response body
  onError: (error, req, ctx) => { }, // Custom error handling
}));
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

app.use("/api", rateLimit(
  // Client ID function (return falsy to skip)
  (req, info, ctx) => req.headers.get("Authorization"),
  {
    maxSize: 20,                // Bucket capacity / burst (default: 20)
    refillSizePerSecond: 10,    // Tokens added per second (default: 10)
    cleanupProbability: 0.001,  // Per-request GC chance (default: 0.001)
    getConsumeSize: (req, info, ctx) => 1, // Tokens per request (default: 1)
  }
));
```

**Active client retention (since 1.7.0):** every request refreshes the entry's
`lastAccess` timestamp, so the periodic cleanup pass cannot evict a client that is still
being limited.

---

## withETag

Wraps a handler to generate ETags and return `304 Not Modified` for cached content.

```ts
import { withETag } from "@marianmeres/demino";

app.get("/api/data", withETag(async () => {
  return await fetchData();
}));

// Weak ETag (faster, less precise)
app.get("/data", withETag(() => content, { weak: true }));

// Lift the size cap (default 1 MiB)
app.get("/large", withETag(handler, { maxSizeBytes: 10 * 1024 * 1024 }));

// Disable the cap entirely
app.get("/anything", withETag(handler, { maxSizeBytes: 0 }));
```

- Only processes GET/HEAD with 2xx responses
- Reads entire response body to compute hash
- Skips hashing for bodies above `maxSizeBytes` (default `1_048_576` since 1.7.0;
  pass `0` or `Infinity` to disable)

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

## Business Rules

- Middleware factories return `DeminoHandler`, not direct handlers
- Return `undefined` to continue chain; return value to stop and respond
- Use `__midwarePreExecuteSortOrder` property to control execution order
- Use `__midwareDuplicable = true` to allow registering same middleware multiple times

## Integration Points

- All middleware integrates with `ctx.locals` for data sharing
- Error middleware can access `ctx.error` for error details
- Logger available via `ctx.getLogger()` in all middleware
