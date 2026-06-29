#!/usr/bin/env node
// selftest.mjs — OFFLINE earned checks for the CORE (no network, no creds).
//
// Proves the security-load-bearing parts actually behave before any live wiring:
// signature ACCEPT on a correct delivery, REJECT on a tampered body, REJECT on a
// wrong key, REJECT on a replayed (stale) timestamp, plus the forward banner +
// allow-list + reply_to logic. Exits 0 only if EVERY assertion holds — a real
// green, not a "ran without error". Run: node selftest.mjs

import assert from "node:assert/strict";
import { verify, sign, MAX_SKEW_SEC } from "./src/verify.mjs";
import {
  bareAddrs,
  parseAllowList,
  recipientAllowed,
  buildBanner,
  buildForwardPayload,
  attachmentNote,
  escapeHtml,
} from "./src/forward.mjs";

let n = 0;
const ok = (name) => { n++; process.stdout.write(`  ✓ ${name}\n`); };

// A `whsec_`-style secret (base64 body) and a frozen clock so the replay window
// is deterministic. NOT a real secret — random local bytes.
const SECRET = "whsec_" + Buffer.from("selftest-not-a-real-secret-000").toString("base64");
const NOW = 1_700_000_000_000; // fixed unix ms
const tsValid = String(Math.floor(NOW / 1000));

function headersFor(id, ts, rawBody, secret = SECRET) {
  return {
    "svix-id": id,
    "svix-timestamp": ts,
    "svix-signature": `v1,${sign(id, ts, rawBody, secret)}`,
  };
}

// 1. ACCEPT a correctly-signed, fresh delivery.
{
  const body = JSON.stringify({ type: "email.received", data: { email_id: "e1" } });
  const r = verify(body, headersFor("msg_1", tsValid, body), SECRET, { now: NOW });
  assert.deepEqual(r, { ok: true, reason: "ok" });
  ok("verify() ACCEPTS a correctly-signed fresh delivery");
}

// 2. REJECT a tampered body (signature was over the original bytes).
{
  const signedBody = JSON.stringify({ type: "email.received", data: { email_id: "e1" } });
  const headers = headersFor("msg_1", tsValid, signedBody);
  const tamperedBody = signedBody.replace("e1", "e2");
  const r = verify(tamperedBody, headers, SECRET, { now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "bad-signature");
  ok("verify() REJECTS a tampered body (integrity)");
}

// 3. REJECT a wrong signing key (authenticity).
{
  const body = "{}";
  const headers = headersFor("msg_1", tsValid, body, "whsec_" + Buffer.from("attacker-key").toString("base64"));
  const r = verify(body, headers, SECRET, { now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "bad-signature");
  ok("verify() REJECTS a wrong signing key (authenticity)");
}

// 4. REJECT a replayed (stale) delivery — captured just outside the ±5-min window,
//    even though its signature is otherwise valid for that timestamp.
{
  const staleTs = String(Math.floor(NOW / 1000) - (MAX_SKEW_SEC + 1));
  const body = "{}";
  const headers = headersFor("msg_1", staleTs, body); // correctly signed for staleTs
  const r = verify(body, headers, SECRET, { now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "stale");
  // and a within-window capture with that same signature passes (proves it's the
  // freshness check firing, not a coincidental signature failure).
  const fresh = verify(body, headersFor("msg_1", String(Math.floor(NOW / 1000) - 10), body), SECRET, { now: NOW });
  assert.equal(fresh.ok, true);
  ok("verify() REJECTS a replayed stale delivery, ACCEPTS one in-window");
}

// 5. REJECT missing headers (no signature at all).
{
  const r = verify("{}", { "svix-id": "x" }, SECRET, { now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "missing-headers");
  ok("verify() REJECTS a delivery with missing svix headers");
}

// 6. forward payload: reply_to = original sender, banner injected, subject fallback.
{
  const mail = {
    from: "Customer <buyer@example.com>",
    to: ["info@shop.dev"],
    subject: "Order question",
    html: "<p>Hi there</p>",
  };
  const payload = buildForwardPayload(mail, { from: "Shop <info@shop.dev>", to: "owner@gmail.com" });
  assert.equal(payload.reply_to, "Customer <buyer@example.com>"); // replies reach sender
  assert.equal(payload.from, "Shop <info@shop.dev>");
  assert.deepEqual(payload.to, ["owner@gmail.com"]);
  assert.equal(payload.subject, "Order question");
  assert.match(payload.html, /^<p style="color:#888/);            // banner FIRST
  assert.match(payload.html, /Forwarded from <b>Customer &lt;buyer@example.com&gt;<\/b>/);
  assert.ok(payload.html.endsWith("<p>Hi there</p>"));            // original AFTER banner
  ok("buildForwardPayload() injects banner + reply_to=sender, html preserved");

  // subject fallback + text-only message wraps in <pre> with the banner.
  const textOnly = buildForwardPayload(
    { from: "a@b.com", text: "plain body" },
    { from: "f@x.com", to: "t@x.com" },
  );
  assert.equal(textOnly.subject, "(no subject)");
  assert.match(textOnly.html, /<pre>plain body<\/pre>$/);
  assert.equal(textOnly.text, "plain body");
  ok("buildForwardPayload() falls back to (no subject) + <pre> for text-only mail");
}

// 7. banner + escaping resists HTML injection through the sender field.
{
  const banner = buildBanner({ from: "<script>alert(1)</script>@evil.com", to: ["info@shop.dev"] });
  assert.doesNotMatch(banner, /<script>/);
  assert.match(banner, /&lt;script&gt;/);
  assert.equal(escapeHtml("a & b < c"), "a &amp; b &lt; c");
  ok("buildBanner()/escapeHtml() neutralise HTML in the sender field");
}

// 8. attachment note surfaces filenames out-of-band (not inlined).
{
  const note = attachmentNote({ attachments: [{ filename: "invoice.pdf" }, { filename: "x.png" }] });
  assert.match(note, /2 attachment\(s\) not inlined: invoice\.pdf, x\.png/);
  assert.equal(attachmentNote({ attachments: [] }), "");
  ok("attachmentNote() lists filenames, empty when none");
}

// 9. allow-list: disabled passes all; enabled drops off-list; unknown recipients pass.
{
  assert.equal(recipientAllowed(["x@a.com"], parseAllowList("")), true);              // disabled
  assert.equal(recipientAllowed(["info@shop.dev"], parseAllowList("info@shop.dev")), true);
  assert.equal(recipientAllowed(["sales@shop.dev"], parseAllowList("info@shop.dev")), false); // off-list
  assert.equal(recipientAllowed([], parseAllowList("info@shop.dev")), true);          // unknown → pass
  assert.deepEqual(bareAddrs(["Info <INFO@Shop.Dev>"]), ["info@shop.dev"]);           // bare + lowercased
  ok("recipientAllowed() honours allow-list, lets unclassifiable mail through");
}

process.stdout.write(`\nselftest: ${n} checks passed\n`);
