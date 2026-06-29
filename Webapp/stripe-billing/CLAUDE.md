# stripe-billing — Hard Constraints

> Domain CLAUDE.md. Canonical for this feature-package. The generator reads this
> before touching anything here.

## ⚠️ STATUS — NOT LIVE-WIRED / UNTESTED (hard constraint)

This package has **not** been connected to working Stripe API keys or a live
webhook, and has **not** been tested against the live Stripe API. **Only the
offline CORE** (signature verification + event→state mapping + the migration
scan) is proven by `selftest.mjs`. The checkout / portal / SDK paths in
`reference/` are **reference-only and UNVERIFIED** against live Stripe. Do **not**
describe this package as production-ready, "working", or "tested end-to-end"
anywhere. Before relying on it: wire real keys + a Stripe webhook endpoint and run
an end-to-end test (a real `checkout.session.completed` flips `plan` to `pro`; a
Stripe-CLI replay is idempotent; a forged signature is rejected `400`).

## What this package is

The FIXED Stripe subscription-lifecycle seam: a webhook-signature **verifier**
(`src/verify-webhook.mjs`), an idempotent event→**absolute-state** mapper
(`src/apply-event.mjs`), a billing migration that makes the state
**server-write-only** (`migrations/`), and a migration **scanner**
(`src/scan-migration.mjs`). Configured per client via env
(`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRO_PRICE_ID`); never
rebuilt. The CORE is dependency-free and offline-testable; the route + SDK glue
are REFERENCE the client wires in.

## HARD constraints

- **This is Stripe RAIL CONFIGURATION, not bespoke payment code.** Stripe owns
  payments, the subscription, and the money. This package only verifies Stripe's
  webhooks and mirrors subscription *state* onto `profiles`. Implementing bespoke
  payment/charge/ledger logic here is the highest dispute-risk surface and a HARD
  finding — it leaves the native-rails boundary (`packages/shopify` / baseline
  §native-rails: "native rails configured & integrated, NEVER rebuilt").
- **Billing columns are SERVER-WRITE-ONLY.** `plan`, `stripe_customer_id`,
  `stripe_subscription_id`, `subscription_status`, `current_period_end` are
  written ONLY by the webhook via the service-role key. The migration must ENABLE
  RLS, REVOKE broad UPDATE from `authenticated`, and GRANT UPDATE on user-editable
  columns ONLY. A billing column appearing in the `authenticated` UPDATE grant (or
  a table-wide grant) is a privilege-escalation finding — the REVOKE-discipline
  gap that let Tessera's DEFECT-1 through. `scan-migration.mjs` enforces this and
  the selftest proves it with a negative control.
- **Webhook handlers are IDEMPOTENT.** Every event maps to ABSOLUTE state, never a
  delta/increment, so Stripe redelivery (which is guaranteed, not exceptional) is
  safe. An increment, an append, or any path whose result depends on how many
  times the event arrived is a HARD finding.
- **Verify over the RAW body, constant-time, ±5-min window.** HMAC-SHA256 over
  `${t}.${rawBody}` keyed by the `whsec_…` secret used verbatim; `timingSafeEqual`
  + length guard; reject outside ±5 min (replay guard). `JSON.parse` only AFTER a
  pass. A naive `===`, a missing freshness check, or parsing before verifying is a
  signature-bypass HARD finding. Matches the studio's n8n HMAC + 5-min replay
  contract (TE-16) and the `inbound-email` verifier discipline.
- **No Stripe SDK in the CORE; nothing vendored.** `verify-webhook` / `apply-event`
  / `scan-migration` / `config` are Node 22 built-ins only. The SDK is needed ONLY
  for outbound checkout/portal in `reference/stripe.reference.ts`, which the client
  installs `stripe` for — it is REFERENCE, untested, and clearly marked.
- **The webhook route MUST be public.** `/api/stripe/webhook` belongs in the
  middleware `PUBLIC_PATHS`, or the auth middleware 307-redirects Stripe's
  unauthenticated POST to `/sign-in` and subscription state silently never updates
  (a recorded ERRORS class). The route's own signature verification keeps a public
  route safe.
- **No secrets in any file.** Secrets come from env or the chmod-600
  `~/.claude/stripe-billing.env` fallback. An `sk_`, `whsec_`, or `price_` secret
  literal committed here is a boundary finding. Fixtures use obviously-fake local
  bytes only.

## What the evaluator checks here

- Signature verified over the raw body, constant-time, with a ±5-min replay window.
- Event mapping is idempotent (absolute state, no deltas).
- Migration: RLS enabled; broad UPDATE revoked from `authenticated`; NO billing
  column in the user UPDATE grant; no table-wide user grant.
- CORE has no Stripe SDK import / no vendored SDK; no committed secret literal.
- `/api/stripe/webhook` documented as a required `PUBLIC_PATHS` entry.
- `selftest.mjs` earns its pass (negative controls fire; exits non-zero on any
  failed assertion).
- STATUS callout present and not contradicted (no overstated readiness).

## Tier gating

Billing feature flag off → the package ships but stays dormant: no webhook route
mounted, the migration's billing columns remain unused, and checkout/portal are
never invoked.

## What stays human (back gate)

The one-time Stripe dashboard setup (create the Product/Price, register the
webhook endpoint + obtain `whsec_…`, set the env) is human-gated, as is the
**live end-to-end test** that lifts this package out of its UNTESTED status. "Did
a real subscription flip the plan and survive a replay" is a human verdict at the
back gate, not a machine one.
