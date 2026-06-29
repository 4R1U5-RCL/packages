#!/usr/bin/env node
// selftest.mjs — OFFLINE earned checks for the CORE (no network, no creds).
//
// ⚠️ This proves ONLY the offline CORE: Stripe-signature verification, the
// event→absolute-state mapper, and the migration billing-grant scan. The
// checkout/portal/SDK paths in reference/ are NOT exercised here and remain
// UNVERIFIED against live Stripe (see README status callout).
//
// Every check is EARNED: a valid signature is constructed with node:crypto and
// must ACCEPT; tampered / wrong-secret / stale variants must REJECT; each event
// maps to the expected absolute state and is idempotent under redelivery; and the
// migration scan passes the real migration while a deliberately-broken one that
// leaks a billing column into the user grant MUST be caught (negative control).
// Exits 0 only if EVERY assertion holds. Run: node selftest.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  sign,
  verifySignature,
  constructEvent,
  parseSignatureHeader,
  MAX_SKEW_SEC,
} from "./src/verify-webhook.mjs";
import { applyEvent, ACTIVE_STATUSES } from "./src/apply-event.mjs";
import { scanMigration, BILLING_COLUMNS } from "./src/scan-migration.mjs";
import { loadConfig, parseEnvFile } from "./src/config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

let n = 0;
const ok = (name) => { n++; process.stdout.write(`  ✓ ${name}\n`); };

// A `whsec_`-style secret (used verbatim as the HMAC key, Stripe-style) and a
// frozen clock so the ±5-min window is deterministic. NOT a real secret.
const SECRET = "whsec_selftest_not_a_real_secret_000";
const NOW_MS = 1_700_000_000_000; // fixed unix ms
const T = Math.floor(NOW_MS / 1000); // unix seconds, as Stripe sends in `t=`

/** Build a valid `Stripe-Signature` header for a body at timestamp `t`. */
function sigHeader(rawBody, t = T, secret = SECRET) {
  return `t=${t},v1=${sign(t, rawBody, secret)}`;
}

// ── 1. Signature verification ───────────────────────────────────────────────

// 1a. ACCEPT a correctly-signed, fresh delivery (the v1 hex is constructed here
//     with node:crypto, so a pass means the math actually matches Stripe's).
{
  const body = JSON.stringify({ id: "evt_1", type: "invoice.paid" });
  const r = verifySignature(body, sigHeader(body), SECRET, { now: NOW_MS });
  assert.deepEqual(r, { ok: true, reason: "ok" });
  ok("verifySignature() ACCEPTS a correctly-signed fresh delivery");
}

// 1b. REJECT a tampered body (signature was over the original bytes).
{
  const signed = JSON.stringify({ id: "evt_1", amount: 100 });
  const header = sigHeader(signed);
  const tampered = signed.replace("100", "999");
  const r = verifySignature(tampered, header, SECRET, { now: NOW_MS });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "signature-mismatch");
  ok("verifySignature() REJECTS a tampered body (integrity)");
}

// 1c. REJECT a wrong signing secret (authenticity) — header signed by an attacker
//     key, otherwise perfectly fresh.
{
  const body = "{}";
  const header = sigHeader(body, T, "whsec_attacker_key");
  const r = verifySignature(body, header, SECRET, { now: NOW_MS });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "signature-mismatch");
  ok("verifySignature() REJECTS a wrong signing secret (authenticity)");
}

// 1d. REJECT a stale/replayed timestamp — correctly signed for an old `t` just
//     outside the ±5-min window; an in-window capture with the same scheme passes
//     (proves it's the freshness guard firing, not a coincidental MAC failure).
{
  const body = "{}";
  const staleT = T - (MAX_SKEW_SEC + 1);
  const stale = verifySignature(body, sigHeader(body, staleT), SECRET, { now: NOW_MS });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, "stale");

  const futureT = T + (MAX_SKEW_SEC + 1);
  const future = verifySignature(body, sigHeader(body, futureT), SECRET, { now: NOW_MS });
  assert.equal(future.reason, "stale");

  const edgeT = T - MAX_SKEW_SEC; // boundary is inclusive
  const edge = verifySignature(body, sigHeader(body, edgeT), SECRET, { now: NOW_MS });
  assert.equal(edge.ok, true);
  ok("verifySignature() REJECTS stale/future timestamps, ACCEPTS the ±5-min edge");
}

// 1e. REJECT missing pieces: no secret (not-wired, fails CLOSED), no header, no t.
{
  const body = "{}";
  assert.equal(verifySignature(body, sigHeader(body), "", { now: NOW_MS }).reason, "not-wired");
  assert.equal(verifySignature(body, "", SECRET, { now: NOW_MS }).reason, "no-signature");
  assert.equal(verifySignature(body, `v1=${sign(T, body, SECRET)}`, SECRET, { now: NOW_MS }).reason, "no-timestamp");
  ok("verifySignature() fails CLOSED on missing secret / header / timestamp");
}

// 1f. parseSignatureHeader handles multiple v1 (key rotation) + ignores v0.
{
  const p = parseSignatureHeader("t=123,v1=aaa,v0=legacy,v1=bbb");
  assert.equal(p.t, "123");
  assert.deepEqual(p.v1, ["aaa", "bbb"]);
  // A header carrying a rotated-in good sig alongside a junk one still verifies.
  const body = "{}";
  const good = sign(T, body, SECRET);
  const r = verifySignature(body, `t=${T},v1=deadbeef,v1=${good}`, SECRET, { now: NOW_MS });
  assert.equal(r.ok, true);
  ok("parseSignatureHeader() collects multiple v1 (rotation), accepts any match");
}

// 1g. constructEvent() mirrors Stripe's SDK: returns the parsed event on a good
//     signature, THROWS on a bad one.
{
  const body = JSON.stringify({ id: "evt_x", type: "invoice.paid" });
  const event = constructEvent(body, sigHeader(body), SECRET, { now: NOW_MS });
  assert.equal(event.id, "evt_x");
  assert.throws(() => constructEvent(body, sigHeader("other"), SECRET, { now: NOW_MS }), /verification failed/);
  ok("constructEvent() returns the event on pass, throws on bad signature");
}

// ── 2. Event → absolute-state mapping + idempotency ─────────────────────────

const CUST = "cus_123";
const SUB = "sub_456";
const PERIOD_END = 1_700_500_000; // unix seconds
const PERIOD_END_ISO = new Date(PERIOD_END * 1000).toISOString();

const subscription = (status) => ({
  id: SUB,
  customer: CUST,
  status,
  items: { data: [{ current_period_end: PERIOD_END }] },
});

const CASES = {
  "checkout.session.completed": {
    event: { type: "checkout.session.completed", data: { object: { client_reference_id: "user_abc", customer: CUST, subscription: SUB } } },
    match: { column: "user_id", value: "user_abc" },
    patch: { plan: "pro", stripe_customer_id: CUST, stripe_subscription_id: SUB, subscription_status: "active" },
  },
  "customer.subscription.created": {
    event: { type: "customer.subscription.created", data: { object: subscription("active") } },
    match: { column: "stripe_customer_id", value: CUST },
    patch: { plan: "pro", stripe_customer_id: CUST, stripe_subscription_id: SUB, subscription_status: "active", current_period_end: PERIOD_END_ISO },
  },
  "customer.subscription.updated (canceled→free)": {
    event: { type: "customer.subscription.updated", data: { object: subscription("canceled") } },
    match: { column: "stripe_customer_id", value: CUST },
    patch: { plan: "free", stripe_customer_id: CUST, stripe_subscription_id: SUB, subscription_status: "canceled", current_period_end: PERIOD_END_ISO },
  },
  "customer.subscription.deleted": {
    event: { type: "customer.subscription.deleted", data: { object: subscription("canceled") } },
    match: { column: "stripe_customer_id", value: CUST },
    patch: { plan: "free", stripe_customer_id: CUST, stripe_subscription_id: SUB, subscription_status: "canceled", current_period_end: PERIOD_END_ISO },
  },
  "invoice.paid": {
    event: { type: "invoice.paid", data: { object: { customer: CUST, subscription: SUB, lines: { data: [{ period: { end: PERIOD_END } }] } } } },
    match: { column: "stripe_customer_id", value: CUST },
    patch: { plan: "pro", stripe_customer_id: CUST, stripe_subscription_id: SUB, subscription_status: "active", current_period_end: PERIOD_END_ISO },
  },
  "invoice.payment_failed": {
    event: { type: "invoice.payment_failed", data: { object: { customer: CUST, subscription: SUB } } },
    match: { column: "stripe_customer_id", value: CUST },
    patch: { stripe_customer_id: CUST, stripe_subscription_id: SUB, subscription_status: "past_due" },
  },
};

for (const [label, c] of Object.entries(CASES)) {
  const r = applyEvent(c.event);
  assert.deepEqual(r.match, c.match, `${label}: match`);
  assert.deepEqual(r.patch, c.patch, `${label}: patch`);
  ok(`applyEvent() maps ${label} → expected absolute patch`);
}

// 2b. trialing also grants pro (ACTIVE_STATUSES); a non-active status downgrades.
{
  assert.equal(applyEvent({ type: "customer.subscription.updated", data: { object: subscription("trialing") } }).patch.plan, "pro");
  assert.equal(applyEvent({ type: "customer.subscription.updated", data: { object: subscription("past_due") } }).patch.plan, "free");
  assert.ok(ACTIVE_STATUSES.includes("trialing"));
  ok("applyEvent() treats trialing as pro, past_due as free (status drives plan)");
}

// 2c. IDEMPOTENCY: the SAME event applied twice yields byte-identical absolute
//     state — redelivery is safe because the mapper returns absolute values, not
//     deltas. (Deep-equal across two independent calls, no shared mutation.)
{
  for (const [label, c] of Object.entries(CASES)) {
    const a = applyEvent(structuredClone(c.event));
    const b = applyEvent(structuredClone(c.event));
    assert.deepEqual(a, b, `${label}: not idempotent`);
  }
  ok("applyEvent() is idempotent — same event twice → identical absolute state");
}

// 2d. Expanded id objects ({id}) resolve identically to bare id strings.
{
  const expanded = { type: "customer.subscription.created", data: { object: { id: SUB, customer: { id: CUST }, status: "active", items: { data: [{ current_period_end: PERIOD_END }] } } } };
  assert.equal(applyEvent(expanded).patch.stripe_customer_id, CUST);
  ok("applyEvent() resolves expanded {id} objects like bare id strings");
}

// 2e. Unhandled event types return null (caller ACKs and ignores).
{
  assert.equal(applyEvent({ type: "customer.created", data: { object: {} } }), null);
  assert.equal(applyEvent({}), null);
  ok("applyEvent() returns null for unhandled event types");
}

// ── 3. Migration scan: billing columns are server-write-only ─────────────────

// 3a. The REAL migration: RLS on, broad UPDATE revoked, and NO billing column in
//     the user grant.
{
  const sql = readFileSync(join(HERE, "migrations", "0001_billing_columns.sql"), "utf8");
  const r = scanMigration(sql);
  assert.equal(r.rlsEnabled, true, "RLS must be enabled");
  assert.equal(r.revokesUpdate, true, "must REVOKE UPDATE from authenticated");
  assert.equal(r.tableWideUserGrant, false, "user grant must be column-scoped");
  assert.deepEqual(r.billingColumnsInUserGrant, [], "no billing column may be user-writable");
  assert.equal(r.ok, true);
  // sanity: every billing column actually exists in the migration text.
  for (const col of BILLING_COLUMNS) assert.match(sql, new RegExp(col), `${col} missing from migration`);
  ok("scanMigration() PASSES the real migration (RLS on, billing cols not user-writable)");
}

// 3b. NEGATIVE CONTROL — a bad migration that leaks `plan` into the user UPDATE
//     grant MUST be caught. Without this firing, 3a proves nothing.
{
  const bad = `
    ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
    REVOKE UPDATE ON public.profiles FROM authenticated;
    GRANT UPDATE (display_name, plan) ON public.profiles TO authenticated;
  `;
  const r = scanMigration(bad);
  assert.equal(r.ok, false);
  assert.deepEqual(r.billingColumnsInUserGrant, ["plan"]);
  ok("scanMigration() CATCHES a billing column leaked into the user grant (negative control)");
}

// 3c. NEGATIVE CONTROL — a table-wide `GRANT UPDATE ... TO authenticated` (no
//     column list) grants ALL columns incl. billing, and MUST be caught.
{
  const bad = `
    ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
    REVOKE UPDATE ON public.profiles FROM authenticated;
    GRANT UPDATE ON public.profiles TO authenticated;
  `;
  const r = scanMigration(bad);
  assert.equal(r.ok, false);
  assert.equal(r.tableWideUserGrant, true);
  ok("scanMigration() CATCHES a table-wide user UPDATE grant (negative control)");
}

// 3d. NEGATIVE CONTROL — a migration with RLS left OFF MUST be caught.
{
  const bad = `
    REVOKE UPDATE ON public.profiles FROM authenticated;
    GRANT UPDATE (display_name) ON public.profiles TO authenticated;
  `;
  const r = scanMigration(bad);
  assert.equal(r.ok, false);
  assert.equal(r.rlsEnabled, false);
  ok("scanMigration() CATCHES a migration with RLS disabled (negative control)");
}

// 3e. A commented-out grant must NOT count as a real leak (comment stripping).
{
  const sql = `
    ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
    REVOKE UPDATE ON public.profiles FROM authenticated;
    -- GRANT UPDATE (plan) ON public.profiles TO authenticated;  (intentionally not applied)
    GRANT UPDATE (display_name) ON public.profiles TO authenticated;
  `;
  const r = scanMigration(sql);
  assert.equal(r.ok, true);
  assert.deepEqual(r.billingColumnsInUserGrant, []);
  ok("scanMigration() ignores a commented-out grant (no false positive)");
}

// ── 4. Config resolution (env first, no secrets in files) ────────────────────
{
  const cfg = loadConfig(
    { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_y", STRIPE_PRO_PRICE_ID: "price_z" },
    "/nonexistent/stripe-billing.env",
  );
  assert.equal(cfg.secretKey, "sk_test_x");
  assert.equal(cfg.webhookSecret, "whsec_y");
  assert.equal(cfg.proPriceId, "price_z");
  assert.deepEqual(cfg.missing, []);

  const partial = loadConfig({ STRIPE_SECRET_KEY: "sk_only" }, "/nonexistent/stripe-billing.env");
  assert.deepEqual(partial.missing, ["STRIPE_WEBHOOK_SECRET", "STRIPE_PRO_PRICE_ID"]);

  assert.deepEqual(parseEnvFile("# c\nSTRIPE_PRO_PRICE_ID=price_q\n"), { STRIPE_PRO_PRICE_ID: "price_q" });
  ok("loadConfig() resolves from env, reports missing keys, no file dependency");
}

process.stdout.write(`\nselftest: ${n} checks passed\n`);
