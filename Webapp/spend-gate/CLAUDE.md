# spend-gate — Hard Constraints

> Domain CLAUDE.md. Canonical for this package. Read it before touching spend-gate.

## What this package is

The app/DB side of a daily token/cost cap: the single pricing-truth module
(`src/cost.mjs`), the `SECURITY DEFINER` spend-read RPC
(`migrations/0001_daily_token_spend.sql`), and a *document* of the hosted gate node
(`docs/n8n-gate-node.md`). It is studio infra consumed by a pinned version.

## HARD constraints — the recurring boundary (root §8)

- **The gate NODE stays hosted, never shipped.** Enforcement (reading caps from
  hosted env and aborting over-cap) runs on YOUR n8n instance. This package ships
  the RPC + pricing module + a *doc* of the node. A live n8n workflow definition
  (`*.workflow.json`) appearing here is a boundary violation, not a build to retry.
- **Pricing lives in ONE place.** `src/cost.mjs` is the only source of rates
  (`MODEL_PRICING`, `FIRECRAWL_USD_PER_PAGE`). n8n records raw counts; this module
  prices them. A second pricing table anywhere is drift — close it back to here.
- **The RPC is service-role-only.** `get_daily_token_spend()` is `SECURITY DEFINER`
  (it bypasses RLS to aggregate), so it MUST `REVOKE` from `public`, `anon`, and
  `authenticated` by name and `GRANT EXECUTE` to `service_role` alone. A grant to
  anon/authenticated is a data-exposure finding (the original TE-5 gap).
- **Config via env, no secrets.** Caps (`TOKEN_CAP`, `USER_DAILY_TOKEN_CAP`) read
  from hosted env only. No token, key, or cap value is committed in this package.
- **Core stays dependency-free + offline-provable.** `src/cost.mjs` is Node 22
  built-ins only and pure (no clock/env/I/O), so `selftest.mjs` earns its pass
  without network or DB. Don't add an npm dep to the pricing core.

## What the evaluator checks here

- No hosted n8n workflow definition present (doc only).
- Exactly one pricing table; `cost()`/`overCap()` are pure and offline-tested.
- The migration is `SECURITY DEFINER`, scalar-returning, and `service_role`-only
  (public/anon/authenticated revoked by name).

## Honest partial state (carry it, don't hide it)

The cap is **wired-but-inert** until the workflow populates `tokens_in`/`tokens_out`
on `tasks` (Tessera Phase-4 / TE-5). The RPC returns `0` and the gate never trips
until then. The README states this plainly; keep it stated.
