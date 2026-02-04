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

Creates CORS headers. Default config is permissive (allows wildcards and credentials).

```ts
import { cors } from "@marianmeres/demino";

// Basic usage
app.use(cors());

// With options
app.use(cors({
  allowOrigin: "*",                    // string | string[] | fn
  allowMethods: ["GET", "POST"],       // string[]
  allowHeaders: ["Content-Type"],      // string[]
  allowCredentials: true,              // boolean
  exposeHeaders: [],                   // string[]
  maxAge: 86400,                       // number (seconds)
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
  preventSSRF: true,              // Block private IPs (default: true)
  allowedHosts: ["*.example.com"], // Host whitelist
  timeout: 30000,                 // Request timeout (ms)
  transformRequest: (req) => req, // Modify outgoing request
  transformResponse: (res) => res, // Modify response
  onError: (error, req, ctx) => { }, // Custom error handling
}));
```

> Does NOT support WebSockets.

---

## rateLimit

Token bucket rate limiting. Throws `429 Too Many Requests` when exceeded.

```ts
import { rateLimit } from "@marianmeres/demino";

app.use("/api", rateLimit(
  // Client ID function (return falsy to skip)
  (req, info, ctx) => req.headers.get("Authorization"),
  {
    maxSize: 100,              // Bucket capacity
    refillSizePerSecond: 10,   // Tokens added per second
    initialSize: 100,          // Starting tokens (default: maxSize)
    consumeSize: 1,            // Tokens per request
  }
));
```

**Headers added**: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`

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
```

- Only processes GET/HEAD with 2xx responses
- Reads entire response body to compute hash

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
