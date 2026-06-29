// src/verify.mjs — Svix/Resend inbound-webhook signature verifier (CORE).
//
// Resend signs inbound webhooks with the Svix scheme. The signed content is
// `${svix-id}.${svix-timestamp}.${rawBody}`, HMAC-SHA256 keyed with the
// base64-decoded secret (the bytes AFTER the `whsec_` prefix), base64-encoded.
//
// This module is dependency-free (Node 22 built-ins only) and PURE: the clock is
// injectable (`opts.now`), so a test asserts accept / reject / replay-rejection
// deterministically offline. It NEVER JSON-parses — verification is over the raw
// request bytes exactly as received (parsing before verifying is the classic
// signature-bypass bug).
//
// Three properties it guarantees, each earned by the selftest:
//   1. integrity   — recomputed HMAC must match (a tampered body fails).
//   2. authenticity — keyed by the shared secret (a wrong key fails).
//   3. freshness   — timestamp within ±5 min of `now` (a replayed capture fails).
// Comparison is constant-time (timingSafeEqual + a length guard).

import { createHmac, timingSafeEqual } from "node:crypto";

export const ID_HEADER = "svix-id";
export const TS_HEADER = "svix-timestamp";
export const SIG_HEADER = "svix-signature";
export const MAX_SKEW_SEC = 300; // ±5 min replay window

/** The raw HMAC key: the `whsec_`-stripped secret, base64-decoded to bytes. */
export function secretKey(secret) {
  return Buffer.from(String(secret).replace(/^whsec_/, ""), "base64");
}

/**
 * The canonical Svix signature for one delivery: base64 HMAC-SHA256 of
 * `${id}.${timestamp}.${rawBody}` under the decoded secret. The single signing
 * primitive — both verify() and the selftest's "valid header" builder use it, so
 * there is exactly one definition of what a correct signature is.
 */
export function sign(id, timestamp, rawBody, secret) {
  return createHmac("sha256", secretKey(secret))
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest("base64");
}

/** Read a header from a Fetch `Headers` object OR a plain (case-insensitive) object. */
function getHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) return headers[k];
  }
  return null;
}

/**
 * Verify an inbound Resend/Svix webhook over its RAW body.
 *
 * @param {string} rawBody  the exact request bytes (await req.text()) — NOT parsed
 * @param {Headers|Record<string,string>} headers  carries svix-id/timestamp/signature
 * @param {string} secret  the `whsec_...` endpoint secret (RESEND_WEBHOOK_SECRET)
 * @param {{now?:number, maxSkewSec?:number}} [opts]  now = unix ms, injected for tests
 * @returns {{ok:boolean, reason:"ok"|"missing-headers"|"stale"|"bad-signature"}}
 *   Structured so callers (and the selftest) can distinguish WHY a delivery was
 *   rejected — never a bare boolean that collapses replay and forgery together.
 */
export function verify(rawBody, headers, secret, opts = {}) {
  const id = getHeader(headers, ID_HEADER);
  const timestamp = getHeader(headers, TS_HEADER);
  const sigHeader = getHeader(headers, SIG_HEADER);
  if (!id || !timestamp || !sigHeader || !secret) {
    return { ok: false, reason: "missing-headers" };
  }

  // Freshness FIRST: reject a stale capture (±5 min) before spending the HMAC.
  const now = opts.now ?? Date.now();
  const maxSkew = opts.maxSkewSec ?? MAX_SKEW_SEC;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > maxSkew) {
    return { ok: false, reason: "stale" };
  }

  // The svix-signature header is a space-delimited list of `v1,<base64sig>`
  // entries (key rotation ships multiple). A constant-time match against ANY
  // current entry is a pass.
  const expectedBuf = Buffer.from(sign(id, timestamp, rawBody, secret));
  const matched = String(sigHeader)
    .split(" ")
    .some((entry) => {
      const candidate = entry.includes(",") ? entry.split(",")[1] : entry;
      const candidateBuf = Buffer.from(candidate ?? "");
      return (
        candidateBuf.length === expectedBuf.length &&
        timingSafeEqual(candidateBuf, expectedBuf)
      );
    });

  return matched ? { ok: true, reason: "ok" } : { ok: false, reason: "bad-signature" };
}
