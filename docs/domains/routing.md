# Routing

## Overview

Demino routing matches incoming request pathnames against registered route patterns. The router extracts named parameters and wildcards from the URL. Multiple router implementations are available; the default is `DeminoSimpleRouter`.

## Key Files

| File | Purpose |
|------|---------|
| `src/router/abstract.ts` | `DeminoRouter` base class |
| `src/router/simple-router.ts` | Default router (bracket params) |
| `src/router/urlpattern-router.ts` | URL Pattern API router |
| `src/router/fixed-router.ts` | Exact string matching only |
| `src/router/regex-router.ts` | Regex-based patterns |
| `src/router/express-like-router.ts` | Express-style (deprecated) |

## Router Implementations

### DeminoSimpleRouter (Default)

Uses bracket syntax for parameters. Powered by `@marianmeres/simple-router`.

```ts
const app = demino();  // Uses DeminoSimpleRouter by default

app.get("/users/[userId]", (r, i, ctx) => ctx.params.userId);
app.get("/files/*", handler);  // Wildcard
```

| Pattern | Example URL | `ctx.params` |
|---------|-------------|--------------|
| `/users/[id]` | `/users/123` | `{ id: "123" }` |
| `/[a]/[b]` | `/foo/bar` | `{ a: "foo", b: "bar" }` |
| `/files/*` | `/files/a/b/c` | `{}` (wildcard matched) |

### DeminoUrlPatternRouter

Uses the [URL Pattern API](https://developer.mozilla.org/en-US/docs/Web/API/URL_Pattern_API) syntax.

```ts
import { DeminoUrlPatternRouter } from "@marianmeres/demino";

const app = demino("", [], { routerFactory: () => new DeminoUrlPatternRouter() });

app.get("/users/:id", (r, i, ctx) => ctx.params.id);
app.get("/files/*", handler);
```

| Pattern | Example URL | `ctx.params` |
|---------|-------------|--------------|
| `/users/:id` | `/users/123` | `{ id: "123" }` |
| `/post/:id/comment/:cid` | `/post/1/comment/2` | `{ id: "1", cid: "2" }` |

### DeminoRegexRouter

Uses regular expressions with named capture groups.

```ts
import { DeminoRegexRouter } from "@marianmeres/demino";

const app = demino("", [], { routerFactory: () => new DeminoRegexRouter() });

app.get("^/(?<year>\\d{4})/(?<month>\\d{2})$", (r, i, ctx) => ctx.params);
// /2024/03 → { year: "2024", month: "03" }
```

### DeminoFixedRouter

Exact string matching only. No parameters or wildcards.

```ts
import { DeminoFixedRouter } from "@marianmeres/demino";

const app = demino("", [], { routerFactory: () => new DeminoFixedRouter() });

app.get("/about", handler);  // Only matches exactly "/about"
```

## Common Operations

### Switching Router

```ts
import { demino, DeminoUrlPatternRouter } from "@marianmeres/demino";

const app = demino("", [], {
  routerFactory: () => new DeminoUrlPatternRouter()
});
```

### Creating Custom Router

```ts
import { DeminoRouter, type DeminoRouterExecResult } from "@marianmeres/demino";

class MyRouter extends DeminoRouter {
  private routes: Map<string, string> = new Map();

  on(route: string): void {
    this.routes.set(route, route);
  }

  exec(pathname: string): DeminoRouterExecResult | undefined {
    for (const [pattern, route] of this.routes) {
      // Custom matching logic
      if (this.matches(pathname, pattern)) {
        return { route, params: this.extractParams(pathname, pattern) };
      }
    }
    return undefined;
  }
}
```

## Integration Points

- Router is instantiated via `routerFactory` option in `demino()` constructor
- Router's `exec()` is called on every request to match pathname
- Matched `params` are frozen and attached to `ctx.params`
- File-based routing (`deminoFileBased`) requires `DeminoSimpleRouter`
