# usage-quota — a rolling-window usage limiter

A self-contained, reusable feature-package: a **rolling-window usage limiter** for
any **countable metered resource** (started tasks, exports, API calls, runs…). A
free tier gets `QUOTA_LIMIT` units per rolling `QUOTA_WINDOW_DAYS`, derived from a
live count of consumed rows. **Pro** subscribers and a **dev allow-list** are
exempt (unlimited). Enforced at the **action boundary** — over quota signals a
redirect to `/billing?reason=quota`.

Generalised from Tessera's `lib/quota.ts` (5 started tasks / rolling 7 days). That
copy hardcodes "tasks"; this package meters *any* countable resource and lifts the
Supabase read out of the core so the math is pure and offline-testable.

```
usage-quota/
├── src/
│   ├── quota.mjs    CORE — pure: evaluateQuota(), getQuota(injected fetchCount),
│   │                windowStart(), loadConfig(). No Supabase, no clock it isn't handed.
│   └── enforce.mjs  the action-boundary seam — enforceQuota() (throws) /
│                    quotaSignal() (returns) → /billing?reason=quota
├── reference/
│   └── quota.supabase.reference.ts   REFERENCE GLUE (not imported, not tested):
│                    example fetchCount = Supabase started-status count + Pro lookup
├── selftest.mjs     OFFLINE earned checks — under/at/over, Pro + allow-list, window math
├── package.json
└── CLAUDE.md         hard constraints for the generator
```

## The line: pure core vs. reference glue

The **core never touches a database**. Its only count source is an **injected**
`async fetchCount(windowStart)` — so `getQuota` runs in the selftest with a stub
counter, no Supabase. The exemption logic (Pro, allow-list) and the window math
live in the core; the Supabase query and the "what counts as Pro" subscription
policy live in `reference/`, which the client adapts. Edit the reference, not the
core.

## The decision (`src/quota.mjs`)

`evaluateQuota({ count, limit, windowDays, isPro, userEmail, allowlist })` is the
pure verdict:

```js
{ allowed, remaining, reason, count, limit, windowDays, exempt }
```

- **Exemptions short-circuit the count** — allow-list (case-insensitive email)
  beats everything, then Pro. Both return `remaining: null` (unlimited). Allow-list
  precedence over Pro/billing state mirrors Tessera's `UNLIMITED_EMAILS`, so dev/
  admin access survives a billing outage.
- **Otherwise** `remaining = max(0, limit - count)`, `allowed = remaining > 0`.
- **`reason`** is one of `pro` · `allowlist` · `within_quota` · `quota`. The last
  one (`REASONS.EXCEEDED`) is the value that drives `?reason=quota`.

`getQuota({ fetchCount, user, cfg, now })` is the only async entry: it resolves the
window boundary, calls the injected `fetchCount(windowStart)` (skipped entirely for
exempt callers — no DB round-trip), and applies the pure decision. `now` is
injected so tests are deterministic.

## Enforce at the boundary (`src/enforce.mjs`)

Gate **server-side**, before the metered side-effect (status flip / trigger /
charge). The UI disable is cosmetic; this is the real gate.

```js
import { getQuota, loadConfig } from "@webapp/usage-quota/quota";
import { enforceQuota } from "@webapp/usage-quota/enforce";

const cfg = loadConfig(process.env);
const quota = await getQuota({ fetchCount, user: { email, isPro }, cfg });
enforceQuota(quota);          // throws QuotaExceededError({ redirect }) when over
await startTheMeteredThing();  // only reached when allowed
```

- `enforceQuota(quota)` — **throws** `QuotaExceededError` (with `.redirect`) when
  over; returns the quota when allowed. Use where the framework interrupts via
  throw (Next.js Server Actions — `redirect()` itself throws).
- `quotaSignal(quota)` — **returns** `{ redirect, quota }` or `null`, for callers
  that branch on a value (API → 302/402, RSC).
- `quotaRedirectUrl({ billingPath, reason })` — builds the URL; defaults
  `/billing?reason=quota`.

## Config (env, no secrets)

| Var | Default | Meaning |
|-----|---------|---------|
| `QUOTA_LIMIT` | `5` | units allowed per window (free tier) |
| `QUOTA_WINDOW_DAYS` | `7` | rolling window length, in days |
| `QUOTA_DEV_ALLOWLIST` | — | comma/space/`;`-separated exempt emails (lowercased) |

These are operational tunables, not credentials — this package holds **no
secrets**. Pro status is resolved by the caller (subscription-store-specific) and
passed in as `user.isPro`; `reference/` shows the Supabase `plan` +
`subscription_status ∈ {active,trialing}` resolution.

## Selftest — an earned pass

```sh
node selftest.mjs
```

Offline, no Supabase, no network. Every assertion would fail if the logic broke:
under/at/over the limit, Pro + allow-list exemptions (with a non-listed negative
control proving the allow-list is what flipped the verdict), exact window math,
`getQuota` driving an injected `fetchCount` (and asserting exempt callers never
call it), the throw/return enforcement signal, and env config parsing. A green run
is the product — not "it ran without error".

## Boundary

- **In scope:** the quota math, the exemption logic, the window boundary, the
  action-boundary signal, env config, and an offline earned selftest.
- **Out of scope (named, not silently skipped):** the actual Supabase read and the
  subscription/Stripe state machine (`reference/` glue the client wires); the
  billing page itself; any cron/scheduled reset — the window is computed at request
  time, there is deliberately no counter column and no reset job.
