# Code Conventions

## File Organisation

```
src/
├── mod.ts              # Main barrel export
├── demino.ts           # Core implementation
├── router/
│   ├── mod.ts          # Router barrel export
│   └── *.ts            # Router implementations
├── middleware/
│   ├── mod.ts          # Middleware barrel export
│   └── *.ts            # Middleware factories
├── misc/
│   ├── mod.ts          # Misc barrel export
│   └── *.ts            # Additional features
└── utils/
    ├── mod.ts          # Utils barrel export
    └── *.ts            # Utility functions
```

**Rules**:
- Each directory has a `mod.ts` barrel that re-exports all public symbols
- Implementation files are siblings to `mod.ts`
- Test files go in `tests/` directory, mirroring `src/` structure

## Naming Conventions

| Item | Convention | Example |
|------|------------|---------|
| Types/Interfaces | `Demino` prefix + PascalCase | `DeminoContext`, `DeminoHandler` |
| Factory functions | camelCase, often `demino` prefix | `demino()`, `deminoCompose()` |
| Middleware factories | camelCase, descriptive | `cors()`, `rateLimit()`, `proxy()` |
| Utility functions | camelCase | `parseCookies()`, `serializeCookie()` |
| Constants | UPPER_SNAKE_CASE | `HTTP_STATUS` (from http-utils) |

## Patterns

### Middleware Factory Pattern

Middleware is created via factory functions that return `DeminoHandler`:

```ts
// Do: Factory with options
export function myMiddleware(options: MyOptions = {}): DeminoHandler {
  return (req, info, ctx) => {
    // Implementation
  };
}

// Don't: Direct handler export
export const myMiddleware: DeminoHandler = (req, info, ctx) => { ... };
```

### Handler Signature

All handlers use the same signature:

```ts
(req: Request, info: Deno.ServeHandlerInfo, ctx: DeminoContext) => any
```

### Response Returns

```ts
// Do: Return data directly
app.get("/users", () => users);              // → JSON
app.get("/", () => "Hello");                  // → text/html
app.get("/empty", () => undefined);           // → 204 No Content
app.get("/custom", () => new Response(...));  // → pass-through

// Don't: Manually stringify JSON
app.get("/users", () => JSON.stringify(users));
```

## Anti-Patterns

| Anti-Pattern | Problem | Solution |
|--------------|---------|----------|
| Returning `undefined` unintentionally | Creates 204 response | Return explicit value or Response |
| Mutating `ctx.params` | Params are frozen | Use `ctx.locals` for derived data |
| Forgetting to await async middleware | Next middleware runs before completion | Always await async operations |
| Reassigning `app.locals` | Assignment is ignored | Mutate properties: `app.locals.foo = bar` |

## Error Handling

Use `@marianmeres/http-utils` for HTTP errors:

```ts
import { createHttpError, HTTP_ERROR } from "@marianmeres/http-utils";

// Do: Throw typed HTTP errors
throw createHttpError(404);
throw createHttpError(401, "Invalid token");
throw new HTTP_ERROR.NotFound();
throw new HTTP_ERROR.Unauthorized("Invalid token");

// Don't: Throw generic errors for HTTP responses
throw new Error("Not found");  // Results in 500, not 404
```

## Testing Standards

- **Location**: `tests/` directory
- **Naming**: `*.test.ts`
- **Framework**: Deno's built-in test runner
- **Assertions**: `@std/assert`

```ts
import { assertEquals } from "@std/assert";

Deno.test("description", async () => {
  const app = demino();
  app.get("/", () => "ok");

  const res = await app(new Request("http://localhost/"), mockInfo);
  assertEquals(res.status, 200);
});
```

Run tests:
```bash
deno task test        # Run all
deno task test:watch  # Watch mode
```
