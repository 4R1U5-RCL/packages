#!/usr/bin/env node
// selftest.mjs — OFFLINE earned checks for the consent gate (no network, no DB).
//
// Proves the gate actually behaves before any live wiring exists: missing/false
// consent is rejected, an accepted+version-pinned record is stamped exactly, the
// rejection is a STRUCTURED error, and — by reading the migration text — that the
// consent columns are genuinely server-write-only (revoked from self-update).
//
// The migration assertion EARNS its pass the audit way: the same scanner is run
// against a deliberately-BAD migration (consent column left in the UPDATE grant)
// and MUST flag it. A scanner that cannot catch the bad input is not a check — so
// a green here means the detector provably fires, not merely "ran without error".
//
// Exits 0 only if every assertion holds. Run: node selftest.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  requireConsent,
  stampConsent,
  ConsentRequiredError,
  ConsentErrorCode,
  CONSENT_VERSION,
  CONSENT_SCHEMA,
} from "./src/consent.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let n = 0;
const ok = (name) => { n++; process.stdout.write(`  ✓ ${name}\n`); };
// assert.throws() returns undefined; grab the actual error to inspect its fields.
const grab = (fn) => { try { fn(); } catch (e) { return e; } throw new assert.AssertionError({ message: "expected a throw, got none" }); };

// 1. Missing consent is rejected with a structured NOT_ACCEPTED error.
{
  const t = grab(() => requireConsent({}));
  assert.ok(t instanceof ConsentRequiredError);
  assert.equal(t.code, ConsentErrorCode.NOT_ACCEPTED);
  // structured: a JSON-able body, no stack leak.
  const j = t.toJSON();
  assert.equal(j.error, "consent_required");
  assert.equal(j.code, "CONSENT_NOT_ACCEPTED");
  assert.equal(j.expectedVersion, CONSENT_VERSION);
  ok("missing consent → structured ConsentRequiredError(NOT_ACCEPTED)");
}

// 2. Falsy / spoofed acceptance values are all rejected — never coerced truthy.
{
  for (const bad of [false, "false", "", 0, null, "no", "1"]) {
    assert.throws(
      () => requireConsent({ accepted: bad, version: CONSENT_VERSION }),
      (e) => e instanceof ConsentRequiredError && e.code === ConsentErrorCode.NOT_ACCEPTED,
      `accepted=${JSON.stringify(bad)} must be rejected`,
    );
  }
  ok("false/empty/spoofed acceptance values all rejected");
}

// 3. Accepted-but-no-version, and accepted-with-STALE-version, are distinct
//    structured rejections (not silently passed).
{
  const miss = grab(() => requireConsent({ accepted: true }));
  assert.ok(miss instanceof ConsentRequiredError);
  assert.equal(miss.code, ConsentErrorCode.VERSION_MISSING);

  const stale = grab(() => requireConsent({ accepted: true, version: "1999-01-01" }));
  assert.ok(stale instanceof ConsentRequiredError);
  assert.equal(stale.code, ConsentErrorCode.VERSION_STALE);
  assert.equal(stale.gotVersion, "1999-01-01");
  assert.equal(stale.expectedVersion, CONSENT_VERSION);
  ok("missing version → VERSION_MISSING; stale version → VERSION_STALE");
}

// 4. A genuine acceptance (incl. the native checkbox "on") passes and returns the
//    validated, server-trusted version.
{
  for (const yes of [true, "on", "true"]) {
    const r = requireConsent({ accepted: yes, version: CONSENT_VERSION });
    assert.deepEqual(r, { accepted: true, version: CONSENT_VERSION });
  }
  ok("true / \"on\" / \"true\" + current version accepted");
}

// 5. stampConsent() builds the exact server-write-only record shape from an
//    INJECTED time — pure and deterministic, version taken from the server.
{
  const at = 1_700_000_000_000;
  const rec = stampConsent({ accepted: "on", version: CONSENT_VERSION }, { at });
  assert.deepEqual(rec, {
    consent_accepted_at: new Date(at).toISOString(),
    consent_version: CONSENT_VERSION,
    schema: CONSENT_SCHEMA,
  });
  // deterministic for a fixed `at`
  assert.deepEqual(rec, stampConsent({ accepted: true, version: CONSENT_VERSION }, { at }));
  // gate still applies through the stamp path
  assert.throws(() => stampConsent({ accepted: false }, { at }), ConsentRequiredError);
  // time must be injected, never read implicitly
  assert.throws(() => stampConsent({ accepted: true, version: CONSENT_VERSION }), TypeError);
  ok("stampConsent() stamps consent_accepted_at+version from injected time; gated; pure");
}

// 6. The record stamps the SERVER's version even if a (valid, current) client
//    string differs in type — the stored value comes from the trusted source.
{
  const at = 0;
  const rec = stampConsent({ accepted: true, version: String(CONSENT_VERSION) }, { at });
  assert.equal(rec.consent_version, CONSENT_VERSION);
  ok("stamped consent_version is the server constant, not the raw input");
}

// --- 7. MIGRATION SCAN: consent columns are server-write-only (REVOKEd from self-update).
//    Scanner first PROVEN to fire on a known-bad migration (negative control),
//    THEN trusted on the real one.
const CONSENT_COLS = ["consent_accepted_at", "consent_version"];

/** Columns named in `grant update (...) ... to authenticated`, or null if none. */
function grantedUpdateColumns(text) {
  const m = text.match(/grant\s+update\s*\(([^)]*)\)\s+on\s+[\w."]+\s+to\s+([^;]*?\bauthenticated\b[^;]*);/i);
  if (!m) return null;
  return m[1].split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}
/** True if table-wide UPDATE is revoked from the user role first. */
function tableUpdateRevoked(text) {
  return /revoke\s+update\s+on\s+[\w."]+\s+from\s+[^;]*\bauthenticated\b/i.test(text);
}
/** The verdict: are the consent columns off the user-writable surface? */
function consentServerWriteOnly(text, cols) {
  if (!tableUpdateRevoked(text)) return { ok: false, reason: "table-wide UPDATE not revoked from authenticated" };
  const granted = grantedUpdateColumns(text);
  if (granted === null) return { ok: true, granted: [] }; // revoked and never re-granted → nothing writable
  const leaked = cols.filter((c) => granted.includes(c));
  return { ok: leaked.length === 0, granted, leaked };
}

{
  // Negative control: a migration that revokes table UPDATE but leaves a consent
  // column inside the re-grant. The scanner MUST catch it.
  const BAD = `
    revoke update on public.profiles from authenticated, anon;
    grant update (full_name, email, consent_version) on public.profiles to authenticated;
  `;
  const badV = consentServerWriteOnly(BAD, CONSENT_COLS);
  assert.equal(badV.ok, false, "scanner failed to catch a consent column left in the UPDATE grant");
  assert.deepEqual(badV.leaked, ["consent_version"]);

  // And a migration that never revokes the table-wide grant at all.
  assert.equal(consentServerWriteOnly("grant update (full_name) on public.profiles to authenticated;", CONSENT_COLS).ok, false);
  ok("migration scanner FIRES on a leaked consent column / missing revoke (negative control)");
}

{
  // Now the real migration must pass that same proven scanner.
  const sql = readFileSync(join(HERE, "migrations", "0001_signup_consent.sql"), "utf8");
  const v = consentServerWriteOnly(sql, CONSENT_COLS);
  assert.equal(v.ok, true, `consent columns are NOT server-write-only: ${JSON.stringify(v)}`);
  // sanity: the user-editable columns ARE re-granted (guards a vacuous pass where
  // nothing is granted because the regex simply missed the statement).
  assert.ok(v.granted.includes("full_name"), "expected user-editable full_name in the UPDATE grant");
  assert.ok(!v.granted.includes("consent_accepted_at") && !v.granted.includes("consent_version"));
  // RLS is enabled on the table (the second lock).
  assert.match(sql, /enable\s+row\s+level\s+security/i);
  ok("real migration: consent columns REVOKEd from self-update + RLS enabled");
}

process.stdout.write(`\nselftest: ${n} checks passed\n`);
