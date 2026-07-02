import { HTTP_ERROR } from "@marianmeres/http-utils";
import {
	type Demino,
	type DeminoContext,
	type DeminoHandler,
	type DeminoMethod,
	withMeta,
} from "../demino.ts";

/**
 * Authorization middleware — a generic, **policy-free** gate built on the Stage-1
 * route-metadata primitive (`ctx.routeMeta` / `withMeta` / `app.routes()`).
 *
 * Demino stays agnostic: the gate never knows what a role or permission *means*.
 * A route declares an opaque permission via `withPermission(...)` (or `withPublic(...)`),
 * and the app supplies a `check(subject, permission, ctx) => boolean` that decides.
 * Wire `@marianmeres/rbac` (or anything) inside `check` — Demino takes no dependency
 * on it.
 *
 * @example
 * ```ts
 * import { authz, withPermission, withPublic } from "@marianmeres/demino";
 * import { Rbac } from "@marianmeres/rbac"; // the APP imports rbac, not demino
 *
 * const rbac = new Rbac();// ...roles/groups/rules...
 *
 * app.use(authz({
 *   resolveSubject: (req) => verifyJwt(req.headers.get("authorization")),
 *   check: (subject, permission) => rbac.can(subject as any, permission),
 * }));
 *
 * app.get("/health", withPublic(() => "ok"));
 * app.get("/invoices/[id]", withPermission("invoice:read", (req, info, ctx) => {
 *   //  ...reached only if check() returned true
 * }));
 * ```
 */

/** The reserved `ctx.routeMeta` key under which the authz declaration is stored.
 * A plain string (not a Symbol) so `permissionMatrix` can serialize a coverage
 * report to JSON. */
export const AUTHZ_META_KEY = "authz";

/**
 * Static per-route authorization declaration, carried in `routeMeta.authz`
 * (via `withPermission` / `withPublic`, or an app-supplied `resolve`).
 */
export type AuthzDecl =
	| { public: true }
	| {
		/** Opaque permission string(s) — meaning is entirely up to the app's `check`. */
		permission: string | string[];
		/** For multiple permissions: require all ("every", default) or any ("some"). */
		mode?: "every" | "some";
	};

/** Options for the {@link authz} gate. */
export interface AuthzOptions {
	/**
	 * Opaque permission check. Returns true to allow. May be async. The app wires
	 * its own policy here (e.g. `(s, p) => rbac.can(s, p)`); ownership/ABAC can load
	 * a resource from `ctx` and decide inside this function.
	 */
	check: (
		subject: unknown,
		permission: string,
		ctx: DeminoContext,
	) => boolean | Promise<boolean>;
	/**
	 * Optional subject resolver. If provided and `ctx.locals[subjectKey]` is not
	 * already set, the gate populates it (even for public routes, so downstream
	 * handlers can read it). MUST return `null`/`undefined` for unauthenticated —
	 * it must not throw. If omitted, the gate reads an already-populated
	 * `ctx.locals[subjectKey]` (so it composes with a separate auth middleware).
	 */
	resolveSubject?: (
		req: Request,
		info: Deno.ServeHandlerInfo,
		ctx: DeminoContext,
	) => unknown | Promise<unknown>;
	/**
	 * Optional fallback declaration for routes that carry no static `withPermission`
	 * /`withPublic`. Keyed on `(method, route)` — NOT on live request state — so the
	 * exact same function can be replayed by {@link permissionMatrix} at build time.
	 * See {@link createRouteResolver}.
	 */
	resolve?: (method: string, route: string) => AuthzDecl | null;
	/** `ctx.locals` slot for the subject. Default `"subject"`. */
	subjectKey?: string;
	/**
	 * Deny (403) when no declaration resolves for a route (fail-closed). Default
	 * `true`. Set `false` only for incremental adoption — undeclared routes then
	 * pass through ungated (and still surface as `MISSING` in the matrix).
	 */
	denyByDefault?: boolean;
	/**
	 * Bypass genuine CORS preflight requests — an `OPTIONS` that carries
	 * `Access-Control-Request-Method`. Default `true`. A bare `OPTIONS` that is NOT a
	 * preflight is still gated, so it cannot reach an `app.all()`/`app.options()`
	 * handler unauthenticated.
	 */
	allowOptions?: boolean;
}

function resolveDecl(
	ctx: DeminoContext,
	resolve: AuthzOptions["resolve"],
	method: string,
): AuthzDecl | null {
	const fromMeta = ctx.routeMeta[AUTHZ_META_KEY] as AuthzDecl | undefined;
	if (fromMeta) return fromMeta;
	return resolve?.(method, ctx.route) ?? null;
}

/**
 * Creates the authorization gate middleware. Register it once, early (typically
 * `app.use(authz(...))`, right after any subject-resolving middleware); it reads
 * each route's declaration from `ctx.routeMeta` and enforces it through the
 * supplied `check`. It runs in normal registration order (not self-pinned).
 *
 * Flow per request: OPTIONS bypass → resolve subject → resolve declaration →
 * (no decl ⇒ 403 unless `denyByDefault:false`) → (public ⇒ allow) →
 * (no subject ⇒ 401) → run `check` (403 on failure).
 */
export function authz(options: AuthzOptions): DeminoHandler {
	const {
		check,
		resolveSubject,
		resolve,
		subjectKey = "subject",
		denyByDefault = true,
		allowOptions = true,
	} = options;

	const gate: DeminoHandler = async (
		req: Request,
		info: Deno.ServeHandlerInfo,
		ctx: DeminoContext,
	) => {
		// CORS preflight — never gated. Scope strictly to a genuine preflight (it
		// carries Access-Control-Request-Method) so a bare OPTIONS to an
		// app.all()/app.options() route can't slip past the gate unauthenticated.
		if (
			allowOptions && req.method === "OPTIONS" &&
			req.headers.has("access-control-request-method")
		) {
			return;
		}

		// Populate the subject if a resolver is given and nothing set it yet.
		// Done before the public short-circuit so handlers always see the subject.
		if (resolveSubject && ctx.locals[subjectKey] == null) {
			ctx.locals[subjectKey] = await resolveSubject(req, info, ctx);
		}

		const decl = resolveDecl(ctx, resolve, req.method);

		// No declaration anywhere → fail closed (or pass through if opted out).
		if (!decl) {
			if (denyByDefault) {
				throw new HTTP_ERROR.Forbidden("Access denied: route not declared");
			}
			return;
		}

		// Explicitly public → allow.
		if ("public" in decl) return;

		// From here a permission is required → a subject is mandatory.
		const subject = ctx.locals[subjectKey];
		if (subject == null) throw new HTTP_ERROR.Unauthorized();

		const perms = Array.isArray(decl.permission)
			? decl.permission
			: [decl.permission];
		const mode = decl.mode ?? "every";

		// An empty permission list must never fail open: a vacuous "every" would
		// grant access without any check. Treat it as a misconfigured deny. (The
		// static `withPermission` helper rejects it up front; this guards decls that
		// reach the gate via `resolve` or a hand-built `routeMeta`.)
		if (!perms.length) throw new HTTP_ERROR.Forbidden();

		let ok = mode === "every";
		for (const p of perms) {
			const verdict = await check(subject, p, ctx);
			if (mode === "every") {
				if (!verdict) {
					ok = false;
					break;
				}
			} else if (verdict) {
				// "some"
				ok = true;
				break;
			}
		}

		if (!ok) throw new HTTP_ERROR.Forbidden();
	};

	// Deliberately NOT self-pinned to an early sort order. The gate runs in normal
	// registration order so it composes with a preceding subject-resolving middleware
	// (`app.use(authMw); app.use(gate)`) — pinning it to DEMINO_SORT.PRE would make it
	// run BEFORE that middleware and miss the subject. A global gate still runs before
	// route-level middleware (stable order: app-globals precede route mws), which is
	// the property that matters. Register it early; pin it yourself
	// (`gate.__midwarePreExecuteSortOrder = DEMINO_SORT.PRE`) only if you must.
	return gate;
}

/**
 * Declares the permission(s) a route requires, as static metadata read by the
 * {@link authz} gate before any middleware runs. Sugar over `withMeta`.
 *
 * @example
 * ```ts
 * app.get("/invoices/[id]", withPermission("invoice:read", handler));
 * app.post("/invoices", withPermission(["invoice:create", "billing:write"], handler, { mode: "every" }));
 * ```
 */
export function withPermission<H extends DeminoHandler>(
	permission: string | string[],
	handler: H,
	opts?: { mode?: "every" | "some" },
): H {
	// An empty permission list would fail open at the gate (vacuous "every"). Reject
	// it at declaration time so the mistake surfaces at boot, not as a silent hole.
	if (Array.isArray(permission) && permission.length === 0) {
		throw new TypeError(
			"withPermission: permission list must not be empty (would fail open). " +
				"Use withPublic() for an intentionally open route.",
		);
	}
	return withMeta(
		{ [AUTHZ_META_KEY]: { permission, ...(opts?.mode ? { mode: opts.mode } : {}) } },
		handler,
	);
}

/**
 * Declares a route as public — the {@link authz} gate allows it without a subject
 * or permission check. Sugar over `withMeta`.
 */
export function withPublic<H extends DeminoHandler>(handler: H): H {
	return withMeta({ [AUTHZ_META_KEY]: { public: true } }, handler);
}

/**
 * Reads the authenticated subject the {@link authz} gate stored in `ctx.locals`,
 * typed. Returns `null` if absent. Avoids a viral generic on `DeminoContext`.
 *
 * @example
 * ```ts
 * const user = getSubject<MyUser>(ctx);
 * ```
 */
export function getSubject<T>(
	ctx: DeminoContext,
	subjectKey: string = "subject",
): T | null {
	return (ctx.locals[subjectKey] as T) ?? null;
}

/**
 * Builds a `(method, route) => AuthzDecl | null` resolver from a route-pattern map,
 * for routes that don't carry a static `withPermission`/`withPublic`. Patterns match
 * the registered route string (e.g. `/users/[id]`), using `*` for a single path
 * segment and `**` for the remainder. First match wins; entries are tried in the
 * given order (array form preserves order; object form uses key order).
 *
 * Because it keys only on `(method, route)` it is replayable by {@link permissionMatrix}
 * at build time — unlike a resolver that inspects live request state.
 *
 * @example
 * ```ts
 * const resolve = createRouteResolver([
 *   ["/health", { public: true }],
 *   ["/api/*\/me/**", { permission: "area.me:access" }],
 *   ["/api/**", { permission: "api:access" }],
 * ]);
 * app.use(authz({ check, resolve }));
 * ```
 */
export function createRouteResolver(
	map: Array<[string, AuthzDecl]> | Record<string, AuthzDecl>,
): (method: string, route: string) => AuthzDecl | null {
	const entries: Array<[string, AuthzDecl]> = Array.isArray(map)
		? map
		: Object.entries(map);
	const compiled = entries.map(([pattern, decl]) =>
		[patternToRegExp(pattern), decl] as const
	);
	return (_method: string, route: string): AuthzDecl | null => {
		for (const [re, decl] of compiled) {
			if (re.test(route)) return decl;
		}
		return null;
	};
}

/** Compile a `*`/`**` route pattern into an anchored RegExp. `**` matches the rest
 * (including slashes), `*` matches a single segment (no slash). Literal chars
 * (incl. `[`/`]` used by the default router's params) are escaped. */
function patternToRegExp(pattern: string): RegExp {
	let out = "";
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i];
		if (ch === "*") {
			if (pattern[i + 1] === "*") {
				out += ".*";
				i++;
			} else {
				out += "[^/]+";
			}
		} else if ("\\^$.|?+()[]{}".includes(ch)) {
			out += "\\" + ch;
		} else {
			out += ch;
		}
	}
	return new RegExp(`^${out}$`);
}

/** One row of the authorization coverage matrix from {@link permissionMatrix}. */
export interface AuthzMatrixRow {
	method: DeminoMethod | "ALL";
	route: string;
	/** How the declaration was found: a required permission, explicitly public, or
	 * none at all (a fail-closed hole — the gate would 403 these by default). */
	declaration: "permission" | "public" | "MISSING";
	/** The required permission(s), when `declaration === "permission"`. */
	permission?: string | string[];
	/** Whether the declaration came from static route meta or the `resolve` fallback. */
	source: "static" | "resolver";
}

/**
 * Build-time authorization coverage report over every route the app can match
 * (via the Stage-1 `app.routes()`). Pair with the SAME `resolve` you pass to
 * {@link authz} so the report reflects what the gate would actually enforce.
 *
 * Use it to audit a composed app for unguarded routes, generate a permission
 * matrix, or assert coverage in CI (see {@link assertCovered}).
 */
export function permissionMatrix(
	app: Demino,
	opts?: { resolve?: (method: string, route: string) => AuthzDecl | null },
): AuthzMatrixRow[] {
	return app.routes().map(({ method, route, meta }) => {
		const fromMeta = meta[AUTHZ_META_KEY] as AuthzDecl | undefined;
		const decl = fromMeta ?? opts?.resolve?.(method, route) ?? null;
		const source: "static" | "resolver" = fromMeta ? "static" : "resolver";
		if (!decl) {
			return { method, route, declaration: "MISSING", source };
		}
		if ("public" in decl) {
			return { method, route, declaration: "public", source };
		}
		return {
			method,
			route,
			declaration: "permission",
			permission: decl.permission,
			source,
		};
	});
}

/**
 * Asserts every matchable route has an explicit authorization declaration (static
 * or via `resolve`); throws listing any `MISSING` routes. The real fail-closed
 * guarantee — run it in a test/at boot. (A runtime gate cannot cover 404/405 or
 * static catch-alls; build-time coverage is what makes "no route ships unguarded"
 * an enforceable invariant.)
 */
export function assertCovered(
	app: Demino,
	opts?: { resolve?: (method: string, route: string) => AuthzDecl | null },
): void {
	const missing = permissionMatrix(app, opts).filter(
		(r) => r.declaration === "MISSING",
	);
	if (missing.length) {
		const list = missing.map((r) => `  ${r.method} ${r.route}`).join("\n");
		throw new Error(`authz: ${missing.length} undeclared route(s):\n${list}`);
	}
}
