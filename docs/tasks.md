# Common Tasks

## Adding a New Middleware

### Steps
1. Create file in `src/middleware/[name].ts`
2. Export factory function returning `DeminoHandler`
3. Add export to `src/middleware/mod.ts`
4. Add tests in `tests/middleware/[name].test.ts`

### Template

```ts
// src/middleware/my-middleware.ts
import type { DeminoHandler } from "../demino.ts";

export interface MyMiddlewareOptions {
  // Options here
}

export function myMiddleware(options: MyMiddlewareOptions = {}): DeminoHandler {
  return (req, info, ctx) => {
    // Implementation
    // Return undefined to continue chain
    // Return value to stop chain and respond
  };
}
```

### Checklist
- [ ] Factory function exported (not direct handler)
- [ ] Options interface exported
- [ ] Added to `src/middleware/mod.ts`
- [ ] Tests pass: `deno task test`

---

## Adding a New Router

### Steps
1. Create file in `src/router/[name]-router.ts`
2. Extend `DeminoRouter` abstract class
3. Implement `on()` and `exec()` methods
4. Add export to `src/router/mod.ts`
5. Add tests in `tests/router/[name]-router.test.ts`

### Template

```ts
// src/router/my-router.ts
import { DeminoRouter, type DeminoRouterExecResult } from "./abstract.ts";

export class MyRouter extends DeminoRouter {
  on(route: string): void {
    // Register route pattern
  }

  exec(pathname: string): DeminoRouterExecResult | undefined {
    // Match pathname against registered routes
    // Return { route, params } or undefined
  }
}
```

### Usage

```ts
const app = demino("", [], { routerFactory: () => new MyRouter() });
```

### Checklist
- [ ] Extends `DeminoRouter`
- [ ] Implements `on()` and `exec()`
- [ ] Added to `src/router/mod.ts`
- [ ] Tests pass

---

## Adding a New Utility

### Steps
1. Create file in `src/utils/[name].ts`
2. Export function(s)
3. Add export to `src/utils/mod.ts`
4. Add tests if non-trivial

### Template

```ts
// src/utils/my-util.ts
export function myUtil(input: string): string {
  // Implementation
}
```

### Checklist
- [ ] Added to `src/utils/mod.ts`
- [ ] Tests pass (if applicable)

---

## Creating File-Based Routes

### Steps
1. Create directory structure under your routes folder
2. Add `index.ts` with HTTP method exports
3. Add `_middleware.ts` for route-specific middleware

### Directory Structure

```
routes/
├── _middleware.ts          # Global middleware (optional)
├── index.ts                # GET / handler
└── users/
    ├── _middleware.ts      # /users middleware (optional)
    ├── index.ts            # GET /users handler
    └── [userId]/
        ├── _middleware.ts  # /users/[userId] middleware
        └── index.ts        # GET /users/[userId] handler
```

### Route File Template

```ts
// routes/users/index.ts
import type { DeminoHandler } from "@marianmeres/demino";

export const GET: DeminoHandler = (req, info, ctx) => {
  return { users: [] };
};

export const POST: DeminoHandler = async (req, info, ctx) => {
  const body = await req.json();
  return { created: true };
};
```

### Middleware File Template

```ts
// routes/users/_middleware.ts
import type { DeminoHandler } from "@marianmeres/demino";

const authMiddleware: DeminoHandler = (req, info, ctx) => {
  // Validation logic
};

export default [authMiddleware];
```

### Setup

```ts
import { demino, deminoFileBased } from "@marianmeres/demino";

const app = demino();
await deminoFileBased(app, "./routes");
Deno.serve(app);
```

### Checklist
- [ ] `index.ts` exports HTTP method handlers (GET, POST, etc.)
- [ ] `_middleware.ts` default exports array of middlewares
- [ ] No directories starting with `_` or `.` (except `_middleware.ts`)
- [ ] Using default router (file-based routing requires DeminoSimpleRouter)

---

## Composing Multiple Apps

### Steps
1. Create separate Demino apps with different mount paths
2. Use `deminoCompose()` to combine them

### Template

```ts
import { demino, deminoCompose } from "@marianmeres/demino";

const app = demino();           // Root routes
const api = demino("/api");     // API routes
const admin = demino("/admin"); // Admin routes

// Each app has isolated middleware
api.use(authMiddleware);
admin.use(adminOnlyMiddleware);

// Compose and serve
Deno.serve(deminoCompose([app, api, admin]));
```

### Checklist
- [ ] Each app has unique mount path
- [ ] Mount paths don't overlap
- [ ] Order in array doesn't matter (routing is by mount path)
