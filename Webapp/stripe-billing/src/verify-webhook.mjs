// src/verify-webhook.mjs — Stripe webhook signature verifier (CORE).
//
// Reproduces Stripe's `webhooks.constructEvent` signature check using Node 22
// built-ins ONLY (node:crypto) — so it is dependency-free, PURE, and
// offline-testable. No Stripe SDK is vendored or required here.
//
// Stripe signs a webhook by sending a `Stripe-Signature` header of the form:
//   t=1700000000,v1=<hex hmac>,v1=<hex hmac during rotation>,v0=<legacy>
// The signed content is `${t}.${rawBody}`; the MAC is HMAC-SHA256 keyed with the
// endpoint signing secret (the WHOLE `whsec_...` string, used verbatim — Stripe
// does NOT base64-decode the secret, unlike Svix), encoded as lowercase hex.
//
// Three properties, each earned by the selftest:
//   1. integrity   — recomputed HMAC must match (a tampered body fails).
//   2. authenticity — keyed by the shared secret (a wrong secret fails).
//   3. freshness   — `t` within ±5 min of `now` (a replayed capture fails).
// Comparison is constant-time (timingSafeEqual + a length guard). The clock is
// injectable (`opts.now`) so accept/reject/replay are deterministic offline.

import { createHmac, timingSafeEqual } from "node:crypto";

export const SIG_HEADER = "stripe-signature";
export const MAX_SKEW_SEC = 300; // ±5-min tolerance — matches Stripe's default.

/**
 * The single signing primitive: lowercase-hex HMAC-SHA256 of `${t}.${rawBody}`
 * keyed by the endpoint secret. Both verify() and the selftest's "valid header"
 * builder call THIS, so there is exactly one definition of a correct signature.
 */
export function sign(timestamp, rawBody, secret) {
  return createHmac("sha256", String(secret))
    .update(`${timestamp}.${rawBody}`, "utf8")
    .digest("hex");
}

/** Parse a `Stripe-Signature` header into its timestamp + all v1 candidates. */
export function parseSignatureHeader(header) {
  const out = { t: null, v1: [] };
  if (!header) return out;
  for (const part of String(header).split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") out.t = value;
    else if (key === "v1") out.v1.push(value);
  }
  return out;
}

/** Constant-time hex compare with a length guard (never short-circuits on bytes). */
function safeEqualHex(a, b) {
  const bufA = Buffer.from(String(a), "utf8");
  const bufB = Buffer.from(String(b), "utf8");
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/**
 * Verify a Stripe webhook over its RAW body. PURE — no I/O, injectable clock.
 *
 * @param {string} rawBody  the exact request bytes (await req.text()) — NOT parsed
 * @param {string} sigHeader  the `Stripe-Signature` header value
 * @param {string} secret  the `whsec_...` endpoint signing secret
 * @param {{now?:number, maxSkewSec?:number}} [opts]  now = unix ms (injected in tests)
 * @returns {{ok:boolean, reason:"ok"|"not-wired"|"no-signature"|"no-timestamp"|"stale"|"signature-mismatch"}}
 *   Structured so callers (and the selftest) can tell WHY a delivery was rejected
 *   — never a bare boolean that collapses replay and forgery together.
 */
export function verifySignature(rawBody, sigHeader, secret, opts = {}) {
  if (!secret) return { ok: false, reason: "not-wired" };
  if (!sigHeader) return { ok: false, reason: "no-signature" };

  const { t, v1 } = parseSignatureHeader(sigHeader);
  if (!t) return { ok: false, reason: "no-timestamp" };
  if (v1.length === 0) return { ok: false, reason: "no-signature" };

  // Freshness FIRST: reject a stale/replayed capture before spending the HMAC.
  const now = opts.now ?? Date.now();
  const maxSkew = opts.maxSkewSec ?? MAX_SKEW_SEC;
  const ts = Number(t);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > maxSkew) {
    return { ok: false, reason: "stale" };
  }

  // Match the expected MAC against ANY v1 candidate (multiple ship during key
  // rotation), constant-time.
  const expected = sign(t, rawBody, secret);
  const matched = v1.some((candidate) => safeEqualHex(candidate, expected));
  return matched ? { ok: true, reason: "ok" } : { ok: false, reason: "signature-mismatch" };
}

/**
 * Drop-in shape of Stripe's `stripe.webhooks.constructEvent`: verify, then return
 * the parsed event — THROWING on a bad signature exactly like the SDK, so the
 * reference route can use it without the SDK present. Built on verifySignature().
 */
export function constructEvent(rawBody, sigHeader, secret, opts = {}) {
  const result = verifySignature(rawBody, sigHeader, secret, opts);
  if (!result.ok) {
    throw new Error(`Webhook signature verification failed: ${result.reason}`);
  }
  return JSON.parse(rawBody);
}
