# stripe-billing — Stripe subscription lifecycle (rail config)

> ⚠️ **STATUS: NOT LIVE-WIRED / UNTESTED.** This package has **not** been
> connected to working Stripe API keys or a live webhook, and has **not** been
> tested against the live Stripe API. Only the offline **CORE** (signature
> verification + event→state mapping) is proven by `selftest.mjs`; the
> checkout / portal / SDK paths are **reference-only and UNVERIFIED** against
> live Stripe. **Wire real keys + a webhook endpoint and run an end-to-end test
> before relying on it.**

A self-contained, reusable feature-package for the full Stripe **subscription
lifecycle**: a Stripe-signature **webhook verifier**, an **idempotent**
event→profile-state **mapper**, and the **server-write-only** billing migration —
plus reference Next.js + SDK glue the client wires in.

This is **Stripe RAIL CONFIGURATION, not bespoke payment code**: Stripe owns
payments, the subscription, and the money. This package only verifies Stripe's
webhooks and mirrors the resulting subscription *state* onto the app's `profiles`
table. (See `CLAUDE.md` — native-rails boundary.)

```
src/
  verify-webhook.mjs   CORE — Stripe-Signature HMAC-SHA256 verify (node:crypto), ±5-min, constant-time
  apply-event.mjs      CORE — pure event → ABSOLUTE profile-state patch (replay-safe / idempotent)
  scan-migration.mjs   CORE — static check that billing columns are NOT user-writable
  config.mjs           env resolution (+ optional ~/.claude/stripe-billing.env fallback)
migrations/
  0001_billing_columns.sql   billing columns as SERVER-WRITE-ONLY (REVOKE/GRANT + RLS)
reference/
  webhook.route.reference.ts REFERENCE Next.js route (raw-body → verify → apply → service upsert)
  stripe.reference.ts        REFERENCE lazy Stripe SDK + checkout/portal/customer (UNTESTED)
selftest.mjs           OFFLINE earned checks — exits non-zero on any failure
```

## Why the CORE has no Stripe SDK

Stripe's `webhooks.constructEvent` is *just* an HMAC over `${t}.${rawBody}` keyed
by the endpoint secret. `verify-webhook.mjs` reproduces that with **node:crypto
only** — so the security-load-bearing part is dependency-free, PURE, and provable
**offline** (the selftest constructs a real valid signature and asserts accept /
tampered-reject / wrong-secret-reject / stale-reject). The Stripe **SDK** is only
needed for the *outbound* checkout/portal calls in `reference/stripe.reference.ts`
— that file is REFERENCE the client installs `stripe` for; **nothing is vendored.**

## Signature verification (CORE)

Stripe sends `Stripe-Signature: t=<unix>,v1=<hex>[,v1=<rotated>]`. The signed
content is `${t}.${rawBody}`; the MAC is HMAC-SHA256 keyed with the **whole**
`whsec_…` endpoint secret (used verbatim — Stripe does *not* base64-decode it),
lowercase hex. Verification is **constant-time** (`timingSafeEqual` + length
guard) and rejects anything outside a **±5-min** window (replay guard). Verify
over the **RAW** body bytes — never `JSON.parse` first.

```js
import { verifySignature, constructEvent } from "stripe-billing/src/verify-webhook.mjs";

const r = verifySignature(rawBody, req.headers.get("stripe-signature"), secret);
if (!r.ok) return new Response(r.reason, { status: 400 }); // not-wired/no-signature/stale/...

// or, drop-in for Stripe's SDK (throws on a bad signature):
const event = constructEvent(rawBody, sig, secret);
```

## Event → ABSOLUTE state (idempotent / replay-safe)

`apply-event.mjs` maps a verified event to `{ match, patch }`: `match` is the
profile row (`user_id` for checkout, `stripe_customer_id` otherwise) and `patch`
is **absolute** profile state — never a delta. Because every value is a full
replacement, Stripe **redelivering** the same event yields the **same** end
state. Handled: `checkout.session.completed`,
`customer.subscription.created/updated/deleted`, `invoice.paid`,
`invoice.payment_failed`. Unknown types → `null` (ACK 200, ignore).

| Event | plan | subscription_status |
|-------|------|---------------------|
| `checkout.session.completed` | `pro` | `active` |
| `customer.subscription.created/updated` | `pro` if active/trialing else `free` | the sub status |
| `customer.subscription.deleted` | `free` | `canceled` |
| `invoice.paid` | `pro` | `active` |
| `invoice.payment_failed` | *(unchanged — grace)* | `past_due` |

## Billing columns are SERVER-WRITE-ONLY

`migrations/0001_billing_columns.sql` adds `plan`, `stripe_customer_id`,
`stripe_subscription_id`, `subscription_status`, `current_period_end` to
`profiles`, **enables RLS**, **REVOKEs** broad UPDATE from `authenticated`, and
**GRANTs** UPDATE only on the user-editable columns — the billing columns are
**never** in that grant. They are mutated **only** by the webhook handler via the
Supabase **service-role** key. `scan-migration.mjs` statically proves this, and
the selftest runs it against both the real migration **and** a deliberately-broken
one that leaks a billing column (negative control).

## Config (env, or `~/.claude/stripe-billing.env` fallback)

| Var | Purpose |
|-----|---------|
| `STRIPE_SECRET_KEY` | `sk_…` secret API key — server only (checkout/portal/customer). |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` endpoint signing secret — webhook verification. |
| `STRIPE_PRO_PRICE_ID` | `price_…` recurring Price id for the Pro plan. |

Resolution: `process.env` first, then the chmod-600 fallback file for any key
still unset. **No secret lives in any file in this package.**

## Wire the route (client app)

Copy `reference/webhook.route.reference.ts` → `app/api/stripe/webhook/route.ts`
and point its imports at the installed package.

> ⚠️ **Add `/api/stripe/webhook` to the middleware `PUBLIC_PATHS`.** Stripe POSTs
> unauthenticated; behind the auth wall the middleware **307-redirects** the POST
> to `/sign-in` and Stripe never reaches the handler — subscription state
> silently never updates. The route self-verifies the signature, so public is
> safe. Confirm: `curl -i https://<domain>/api/stripe/webhook` returns **400**
> (bad signature), not **307**.

## Prove it (offline, before any live wiring)

```bash
node selftest.mjs   # signature accept/tamper/wrong-secret/stale, event mapping +
                    # idempotency, migration grant scan + negative controls.
                    # Exits non-zero on any failure.
```

This proves the **CORE only**. It does **not** prove the checkout/portal/SDK glue
or any live Stripe behaviour — see the status callout at the top.

## Boundary

Stripe RAIL CONFIGURATION only. No bespoke payment infrastructure: Stripe owns
payments and the subscription; this package verifies its webhooks and mirrors
subscription *state*. Billing columns are server-write-only; webhook handlers are
idempotent. See `CLAUDE.md`.
