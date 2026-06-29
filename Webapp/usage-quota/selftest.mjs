#!/usr/bin/env node
// usage-quota/selftest.mjs — OFFLINE earned checks for the CORE (no Supabase, no
// network, no creds). Proves the quota math + exemption logic + window boundary +
// the action-boundary signal actually behave — a real green, not "ran without
// error". Every assertion would fail if the logic broke; the suite exits non-zero
// on the first failed assertion. Run: node selftest.mjs

import assert from "node:assert/strict";
import {
  evaluateQuota,
  getQuota,
  windowStart,
  loadConfig,
  parseAllowlist,
  REASONS,
} from "./src/quota.mjs";
import {
  enforceQuota,
  quotaSignal,
  quotaRedirectUrl,
  QuotaExceededError,
} from "./src/enforce.mjs";

let n = 0;
const ok = (name) => {
  n++;
  process.stdout.write(`  ✓ ${name}\n`);
};

const LIMIT = 5;
const WINDOW = 7;

// 1. UNDER limit → allowed, remaining counts down, reason = within_quota.
{
  const q = evaluateQuota({ count: 2, limit: LIMIT, windowDays: WINDOW });
  assert.equal(q.allowed, true);
  assert.equal(q.remaining, 3);
  assert.equal(q.reason, REASONS.WITHIN);
  assert.equal(q.exempt, false);
  // boundary just-under: last unit still allowed
  const last = evaluateQuota({ count: 4, limit: LIMIT, windowDays: WINDOW });
  assert.equal(last.allowed, true);
  assert.equal(last.remaining, 1);
  ok("under limit → allowed, remaining decremented");
}

// 2. AT limit (count == limit) → blocked, remaining 0, reason = quota.
{
  const q = evaluateQuota({ count: LIMIT, limit: LIMIT, windowDays: WINDOW });
  assert.equal(q.allowed, false);
  assert.equal(q.remaining, 0);
  assert.equal(q.reason, REASONS.EXCEEDED);
  ok("at limit → blocked, remaining 0, reason 'quota'");
}

// 3. OVER limit (count > limit) → blocked, remaining floored at 0 (never negative).
{
  const q = evaluateQuota({ count: 9, limit: LIMIT, windowDays: WINDOW });
  assert.equal(q.allowed, false);
  assert.equal(q.remaining, 0);
  assert.equal(q.reason, REASONS.EXCEEDED);
  ok("over limit → blocked, remaining floored at 0");
}

// 4. PRO exemption → unlimited regardless of count (even far over the limit).
{
  const q = evaluateQuota({ count: 999, limit: LIMIT, windowDays: WINDOW, isPro: true });
  assert.equal(q.allowed, true);
  assert.equal(q.remaining, null); // null == unlimited
  assert.equal(q.limit, null);
  assert.equal(q.reason, REASONS.PRO);
  assert.equal(q.exempt, true);
  ok("Pro subscriber → unlimited, ignores count");
}

// 5. ALLOW-LIST exemption → unlimited, case-insensitive, and takes precedence
//    over a not-pro free user who is over the limit.
{
  const allowlist = ["dev@example.dev", "admin@example.dev"];
  const q = evaluateQuota({
    count: 50,
    limit: LIMIT,
    windowDays: WINDOW,
    isPro: false,
    userEmail: "ADMIN@Example.Dev", // different case on purpose
    allowlist,
  });
  assert.equal(q.allowed, true);
  assert.equal(q.remaining, null);
  assert.equal(q.reason, REASONS.ALLOWLIST);
  // negative control: a NON-listed email at the same count is blocked, proving
  // the allow-list is what flipped the verdict (not a pass-through).
  const stranger = evaluateQuota({
    count: 50,
    limit: LIMIT,
    windowDays: WINDOW,
    userEmail: "stranger@example.dev",
    allowlist,
  });
  assert.equal(stranger.allowed, false);
  assert.equal(stranger.reason, REASONS.EXCEEDED);
  ok("allow-list → unlimited (case-insensitive); non-listed at same count blocked");
}

// 6. WINDOW MATH — windowStart is exactly now - windowDays, deterministic.
{
  const now = new Date("2026-06-28T00:00:00.000Z");
  const start = windowStart(WINDOW, now);
  assert.equal(start, "2026-06-21T00:00:00.000Z"); // 7 days earlier, to the ms
  // a 1-day window from the same instant
  assert.equal(windowStart(1, now), "2026-06-27T00:00:00.000Z");
  // accepts epoch-ms too
  assert.equal(windowStart(WINDOW, now.getTime()), "2026-06-21T00:00:00.000Z");
  ok("windowStart() = now - windowDays, exact & deterministic");
}

// 7. getQuota() end-to-end with an INJECTED fetchCount (no Supabase). Asserts the
//    injected window boundary is what the counter is asked for, then applies math.
{
  let askedFor = null;
  const fetchCount = async (start) => {
    askedFor = start;
    return 4; // user has consumed 4 in the window
  };
  const cfg = { limit: LIMIT, windowDays: WINDOW, allowlist: [] };
  const now = new Date("2026-06-28T00:00:00.000Z");
  const q = await getQuota({ fetchCount, user: { email: "u@x.dev", isPro: false }, cfg, now });
  assert.equal(askedFor, "2026-06-21T00:00:00.000Z"); // got the right windowStart
  assert.equal(q.allowed, true);
  assert.equal(q.remaining, 1);
  assert.equal(q.reason, REASONS.WITHIN);
  ok("getQuota() wires fetchCount(windowStart) → decision (offline)");
}

// 8. getQuota() exemptions SHORT-CIRCUIT the counter (no DB round-trip for
//    Pro / allow-list). The injected fetchCount must NOT be called.
{
  const cfg = { limit: LIMIT, windowDays: WINDOW, allowlist: ["dev@x.dev"] };
  let called = false;
  const fetchCount = async () => {
    called = true;
    return 999;
  };
  const pro = await getQuota({ fetchCount, user: { email: "p@x.dev", isPro: true }, cfg });
  assert.equal(pro.allowed, true);
  assert.equal(pro.reason, REASONS.PRO);
  assert.equal(called, false, "Pro must not hit the counter");

  const dev = await getQuota({ fetchCount, user: { email: "DEV@x.dev", isPro: false }, cfg });
  assert.equal(dev.allowed, true);
  assert.equal(dev.reason, REASONS.ALLOWLIST);
  assert.equal(called, false, "allow-list must not hit the counter");
  ok("getQuota() exemptions short-circuit the injected counter");
}

// 9. ENFORCE at the action boundary — throws on over, with the redirect signal;
//    returns the quota unchanged when allowed.
{
  const over = evaluateQuota({ count: LIMIT, limit: LIMIT, windowDays: WINDOW });
  assert.throws(
    () => enforceQuota(over),
    (err) => {
      assert.ok(err instanceof QuotaExceededError);
      assert.equal(err.redirect, "/billing?reason=quota");
      assert.equal(err.quota, over);
      return true;
    },
  );
  const under = evaluateQuota({ count: 1, limit: LIMIT, windowDays: WINDOW });
  assert.equal(enforceQuota(under), under); // pass-through when allowed

  // non-throwing variant: signal object on block, null when allowed
  assert.deepEqual(quotaSignal(over), { redirect: "/billing?reason=quota", quota: over });
  assert.equal(quotaSignal(under), null);

  // custom billing path + reason, and query-param joining
  assert.equal(quotaRedirectUrl(), "/billing?reason=quota");
  assert.equal(
    quotaRedirectUrl({ billingPath: "/account/upgrade", reason: "limit" }),
    "/account/upgrade?reason=limit",
  );
  assert.equal(
    quotaRedirectUrl({ billingPath: "/billing?tab=plan" }),
    "/billing?tab=plan&reason=quota",
  );
  ok("enforceQuota() throws redirect signal on over; pass-through when allowed");
}

// 10. CONFIG from env — limit/window parsed, allow-list split/trimmed/lowercased,
//     bad/empty values fall back to defaults. NO secrets involved.
{
  assert.deepEqual(parseAllowlist("A@x.dev, B@x.dev ;c@x.dev\n  d@x.dev"), [
    "a@x.dev",
    "b@x.dev",
    "c@x.dev",
    "d@x.dev",
  ]);
  assert.deepEqual(parseAllowlist(""), []);
  assert.deepEqual(parseAllowlist(undefined), []);

  const cfg = loadConfig({
    QUOTA_LIMIT: "10",
    QUOTA_WINDOW_DAYS: "30",
    QUOTA_DEV_ALLOWLIST: "Dev@x.dev",
  });
  assert.equal(cfg.limit, 10);
  assert.equal(cfg.windowDays, 30);
  assert.deepEqual(cfg.allowlist, ["dev@x.dev"]);

  const defaults = loadConfig({ QUOTA_LIMIT: "nope", QUOTA_WINDOW_DAYS: "" });
  assert.equal(defaults.limit, 5); // DEFAULT_LIMIT
  assert.equal(defaults.windowDays, 7); // DEFAULT_WINDOW_DAYS
  assert.deepEqual(defaults.allowlist, []);
  ok("loadConfig() parses env, lowercases allow-list, falls back on bad input");
}

// 11. getQuota() guards a missing injected counter (loud, not a silent pass).
{
  await assert.rejects(
    () => getQuota({ user: { email: "u@x.dev" }, cfg: { limit: 5, windowDays: 7, allowlist: [] } }),
    /fetchCount must be an injected async function/,
  );
  ok("getQuota() rejects when fetchCount is not injected");
}

process.stdout.write(`\nselftest: ${n} checks passed\n`);
