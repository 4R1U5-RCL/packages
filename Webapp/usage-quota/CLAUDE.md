# usage-quota — Hard Constraints

> Domain CLAUDE.md. Canonical for this package. The generator reads this before
> touching usage-quota.

## What this package is

The FIXED rolling-window usage limiter for a countable metered resource. Built
once, reused per client by feeding config (`QUOTA_LIMIT`, `QUOTA_WINDOW_DAYS`,
`QUOTA_DEV_ALLOWLIST`) and an INJECTED count source — never rebuilt per client.
Generalised from Tessera's `lib/quota.ts`; not task-specific.

## HARD constraints

- **The core is pure and DB-agnostic.** `src/quota.mjs` and `src/enforce.mjs` use
  Node-22 built-ins only, no npm deps, perform no I/O, and read no clock they are
  not handed (`now` and `fetchCount` are injected). A Supabase/HTTP import, a
  `Date.now()` buried in the math, or any database call inside `src/` is a
  TEMPLATE GAP (the count source belongs behind the injected `fetchCount` seam),
  not a build task.
- **Reference glue stays reference.** `reference/quota.supabase.reference.ts` is
  example wiring the client adapts; it is NOT imported by the core and NOT covered
  by the selftest. The selftest MUST stay offline.
- **Config, not code.** Limit, window, and allow-list come from env via
  `loadConfig`. A client's specific limit, window, or email appearing as a literal
  in `src/` is a boundary finding — push it to config.
- **No secrets.** Quota tunables are operational config, not credentials. This
  package reads no tokens and stores none. `.env*` is gitignored regardless.
- **Enforce server-side, at the action boundary.** The gate runs before the
  metered side-effect; the over-quota signal is a redirect to
  `/billing?reason=quota`. UI gating is cosmetic and never the enforcement point.
- **Exemptions short-circuit the count.** Allow-list (case-insensitive email)
  takes precedence over Pro and over billing state, so dev/admin access survives a
  billing outage — matching Tessera's `UNLIMITED_EMAILS`. Pro is trusted as a
  resolved boolean; the "what counts as Pro" policy stays in the caller/reference.
- **The selftest earns its pass.** Every assertion must be able to fail if the
  logic breaks (under/at/over, both exemptions with a non-listed negative control,
  exact window math). A check that cannot fail on bad input is not a check yet.

## What the evaluator checks here

- No DB/network import or hidden clock in `src/` (count + time are injected).
- Limit/window/allow-list resolve through `loadConfig(env)`, not literals.
- The over-quota path yields the `/billing?reason=quota` redirect signal.
- `selftest.mjs` runs offline and exits non-zero on any failed assertion.

## What stays human (back gate)

Pricing and the Pro cap. "Is 5/week the right free tier? Is Pro unlimited or
capped?" is a business decision set from real cost data (Tessera's Phase 4), not a
machine ground truth. The package enforces whatever limit it is given; it does not
decide the number.
