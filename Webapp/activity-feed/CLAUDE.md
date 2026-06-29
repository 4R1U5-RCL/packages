# activity-feed — Hard Constraints

> Domain CLAUDE.md. Canonical for this package.

## What this package is

The single `logEvent()` seam + `activity_events` table for a per-user in-app audit
trail. One funnel for "what happened", so the row shape and validation live in ONE
place instead of drifting across inline writes in every server action.

## HARD constraints

- **Server-only insert.** The `activity_events` insert path is service-role only.
  A user MUST NOT be able to write (or alter) their own audit trail — a forgeable
  audit log is worse than none. The migration REVOKEs insert/update from the user
  role; the selftest asserts it.
- **Owner-scoped RLS.** Every row is readable only by its `user_id` owner. RLS is
  enabled on the table from the first migration (baseline §5) — a missing/loose
  policy is a hard finding.
- **Closed vocabulary, not free strings.** `type` ∈ `TYPES` and `level` ∈ `LEVELS`
  (`src/log-event.mjs`). New lifecycle events add a member to the FIXED list
  (everyone gets it); they do not invent an ad-hoc string at the call site. This
  is the whole point of the seam — keep it closed.
- **Pure core, injected boundary.** `buildEvent` reads no clock and no DB (caller
  injects `at` and `insert`). Do not reach for `Date.now()` or a Supabase client
  inside the core — that is what makes it offline-testable.
- **App data only (§8.1).** This is data Shopify does not own. It is NOT a mirror
  of any commercial state; do not log order/stock/payment fields here as a
  parallel source of truth.

## What the evaluator checks here

- `activity_events` has owner-scoped RLS and server-only insert (REVOKE present).
- `buildEvent`/`logEvent` validate against the closed `TYPES`/`LEVELS` sets.
- No clock/DB access inside the pure core.

## Note (speculative extraction)

This seam does not yet exist in Tessera as a module — the activity writes are
inline. Adopting this package is a deliberate refactor (route the inline writes
through `logEvent`), not a drop-in. Recorded honestly so it isn't mistaken for a
lift-and-shift.
