# Reverse proxies and `X-Forwarded-*` header spoofing

This document explains the threat model behind Demino's
[`trustProxy`](../API.md#deminooptions) option, `ctx.url`, and the gating of `ctx.ip`.
It is background for *why* the API is shaped the way it is; for usage, see the
[README's "Behind a reverse proxy" section](../README.md) and
[`API.md`](../API.md#deminooptions).

## TL;DR

`X-Forwarded-Proto`, `X-Forwarded-Host`, and `X-Forwarded-For` are **unauthenticated,
attacker-controllable request headers**. They are only meaningful when a trusted reverse
proxy sets them *and* the origin cannot be reached without traversing that proxy. Demino
therefore ignores them by default and trusts them only under an explicit, scoped opt-in.

## The setup that creates the problem

A TLS-terminating reverse proxy (Cloudflare, nginx, a cloud load balancer) accepts the
client's HTTPS connection on `:443` and forwards it to the origin app over a private,
plaintext hop:

```
client ──HTTPS:443──▶ proxy (terminates TLS) ──HTTP──▶ origin (127.0.0.1:8888)
        example.com                                     Deno.serve(app)
```

At the origin, the native request has *lost* the client-facing context:

- `req.url` is `http://127.0.0.1:8888/…` — scheme is `http`, host is the internal bind
  address, not `https://example.com/…`.
- the TCP peer is the proxy, not the real client.

To recover that context, the proxy re-attaches it as headers:

| Header                | Carries                        | Example          |
| --------------------- | ------------------------------ | ---------------- |
| `X-Forwarded-Proto`   | client-facing scheme           | `https`          |
| `X-Forwarded-Host`    | client-facing host[:port]      | `example.com`    |
| `X-Forwarded-Port`    | client-facing port             | `443`            |
| `X-Forwarded-For`     | client IP (and proxy chain)    | `203.0.113.7`    |

The application reconstructs `https://example.com/…` and the real client IP from these.
**That reconstruction is the attack surface.**

## Why the headers cannot be trusted on their own

HTTP provides no authentication for these headers. They are ordinary request headers —
identical in kind to `User-Agent` or `Accept`. Nothing in the protocol distinguishes a
value written by *your* proxy from one written by *the client*. The only thing that makes
them trustworthy in practice is a deployment guarantee:

> **The origin is reachable only through the trusted proxy.**

If that holds (origin bound to loopback, firewalled to the proxy's IPs, on a private
network, or behind a unix socket), then the proxy is the sole party able to set the
headers, and overwriting them is safe. If it does **not** hold — the origin also answers
on a public interface, a peer pod can reach it, an SSRF primitive elsewhere can hit it —
then any of those actors can forge the headers, and trusting them means **trusting
attacker-controlled input to describe the request to itself.**

This is why trust must be *opt-in* (`trustProxy`, default off): the framework cannot know
whether your origin is locked down, so it assumes the worst until told otherwise.

## The risk gradient

Not all three headers are equally dangerous, so they are trusted at different thresholds.

### `X-Forwarded-Proto` — low risk

A two-member enum (`http` | `https`). The worst a forged value does is flip a derived
scheme, e.g. produce an `http://` link. No data is exfiltrated, no host is impersonated.
Trusted whenever `trustProxy` is on.

### `X-Forwarded-Host` — high risk

This is the dangerous one, because applications routinely build security-sensitive
artifacts from "their own" hostname, and a forged host hijacks all of them:

- **Account-takeover via poisoned links.** A password-reset or email-verification flow
  that builds `https://{host}/reset?token=…` from the forwarded host emits
  `https://evil.com/reset?token=…`. The victim clicks; the single-use token is delivered
  to the attacker.
- **Web cache poisoning.** If a CDN or reverse cache keys on path but not host, a single
  attacker request with `X-Forwarded-Host: evil.com` can cache a response whose absolute
  URLs/scripts point at `evil.com`, then serve it to every subsequent visitor.
- **Open redirect / SSRF pivots.** Any redirect or server-side fetch derived from the
  self-host can be aimed at an attacker-chosen origin.

Because of this, `X-Forwarded-Host` is reflected **only** when it matches an explicit
allowlist (`trustProxy: { allowedHosts: [...] }`). A non-matching value is discarded and
the request host is kept. An app that needs only relative URLs never needs this at all.

### `X-Forwarded-For` — high risk for identity decisions

`ctx.ip` derives from this. A forged value defeats anything that treats the IP as an
identity or trust signal: rate limiting, IP allow/deny lists, geo-restriction, abuse
heuristics, and audit logs. Demino gates `ctx.ip` on the same `trustProxy` flag — see
[ctx.ip](#ctxip).

## How Demino applies the model

| `trustProxy`            | `ctx.url` scheme | `ctx.url` host             | `ctx.ip`                         |
| ----------------------- | ---------------- | -------------------------- | -------------------------------- |
| unset / `false`         | from `req.url`   | from `req.url`             | direct socket peer               |
| `true`                  | `X-Forwarded-Proto` | from `req.url` (host NOT reflected) | from forwarding headers |
| `{ allowedHosts: [...] }` | `X-Forwarded-Proto` | `X-Forwarded-Host` if allowlisted, else request host | from forwarding headers |

When `trustProxy` is unset, `ctx.url === new URL(req.url)` and `ctx.ip` is the TCP peer —
**no forwarding header influences any output.** This is the safe default and is
byte-for-byte the legacy behavior for `ctx.url`-derived values.

The implementation lives in [`src/demino.ts`](../src/demino.ts):
`resolveRequestUrl()` builds `ctx.url`, `resolveForwardedAuthority()` validates the host,
and `resolveClientIp()` builds `ctx.ip`. All three are private.

### `ctx.ip`

`ctx.ip` is the direct socket peer when `trustProxy` is off, and is resolved from the
forwarding headers (via `request-ip`: `CF-Connecting-IP`, the left-most `X-Forwarded-For`,
`X-Real-IP`, …) when it is on. This was a **behavior change** — `ctx.ip` previously
trusted `X-Forwarded-For` unconditionally. An app behind a proxy that reads `ctx.ip` (or
keys [`rateLimit()`](../README.md#ratelimit) on it) must set `trustProxy` to keep seeing
the real client IP. The upside: with `trustProxy` off, a client cannot spoof its IP to
evade or poison an IP-keyed rate limiter.

## Two non-obvious pitfalls

The general principle "validate untrusted input against what you expect" has two sharp
edges specific to URL/host handling. Both are handled in the implementation; they are
documented here because they are easy to reintroduce.

### 1. Validate *after* parsing, never the raw string

It is tempting to allowlist-check the raw `X-Forwarded-Host` string and then hand it to a
URL. **The string you validate must be the exact value you apply** — otherwise a
host-terminating character smuggles a different host past the check. The WHATWG URL parser
treats `#`, `/`, `\`, `?` (and userinfo `@`) as authority terminators:

```
raw header:                 evil.com#.example.com
isHostAllowed(raw, ["*.example.com"])  →  true   // ".example.com" is a suffix of the string
new URL("http://" + raw).hostname      →  "evil.com"   // parser stops at '#'
```

Validating the *raw* string accepts it (the string ends in `.example.com`); applying it
yields the foreign host `evil.com`. The fix is to parse first, then validate the
*normalized* `hostname`, and additionally reject any non-bare authority (smuggled
userinfo/path/query/fragment) and empty-label hosts (`.example.com`, `a..example.com`).
Parsing also folds case, so a mixed-case forwarded host still matches a lowercase
allowlist. See `resolveForwardedAuthority()` in [`src/demino.ts`](../src/demino.ts).

### 2. Range-check ports; do not leak the internal one

The WHATWG `URL.port` setter **silently ignores** out-of-range values (`> 65535`) and
accepts `0`. Since `ctx.url` starts life as the internal origin (`…:8888`), a digit-shape
check alone (`/^\d+$/`) is not enough: a value like `99999` passes the regex, the setter
no-ops, and the *internal* `:8888` survives into the absolute self-URL. Ports are therefore
range-checked to `1..65535`; anything else clears the port so the protocol default applies.

## The "immediate-hop / overwrite-not-append" rule

`X-Forwarded-*` headers can be comma-separated *lists* that grow as a request crosses
multiple proxies (`client, proxy-a, proxy-b`). A client can **pre-seed** a value that an
appending proxy then extends:

```
client sends:   X-Forwarded-For: 1.2.3.4         (a lie)
nginx appends:  X-Forwarded-For: 1.2.3.4, <real-client-ip>
```

You can only trust the portion *your* trusted proxy controls. Demino reads the **left-most
token** (immediate-hop semantics) and the security contract is therefore: **put a single
trusted proxy in front, configured to OVERWRITE these headers** (nginx's
`proxy_set_header X-Forwarded-Proto $scheme;` overwrites). Demino deliberately does **not**
implement "trust N hops from the right" / proxy-IP-chain walking — that machinery is where
spoofing bugs live, and it is unnecessary for the single-trusted-proxy topology these
headers are designed for.

## Operator checklist

To safely set `trustProxy: { allowedHosts: ["example.com", "*.example.com"] }`:

1. **Lock the origin to the proxy.** The origin must not be reachable except through the
   trusted proxy — bind to loopback/private interface and/or firewall to the proxy's
   addresses (e.g. Cloudflare IP ranges via a host firewall). This is the precondition
   that makes the headers trustworthy at all.
2. **Configure the proxy to set (overwrite) the headers**, e.g. nginx:
   ```nginx
   proxy_set_header X-Forwarded-Proto $scheme;
   proxy_set_header X-Forwarded-Host  $host;
   proxy_set_header X-Forwarded-For   $remote_addr;   # overwrite, not proxy_add_*
   ```
3. **Keep `allowedHosts` tight and lowercase.** List only the hostnames the app actually
   serves; use `*.domain` only if you genuinely trust every subdomain.
4. **Audit anything built from the host.** Password-reset links, canonical URLs, CORS
   reflections, cache keys — confirm they read `ctx.url`, not a raw header, and that the
   allowlist covers exactly the intended hosts.

## See also

- [README — Behind a reverse proxy](../README.md)
- [API.md — `DeminoOptions.trustProxy`](../API.md#deminooptions)
- [`src/demino.ts`](../src/demino.ts) — `resolveRequestUrl`, `resolveForwardedAuthority`,
  `resolveClientIp`
- [AGENTS.md — trustProxy / proxy-aware ctx.url](../AGENTS.md)
