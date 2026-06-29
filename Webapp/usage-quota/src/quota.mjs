// usage-quota/src/quota.mjs — the CORE: a rolling-window usage limiter.
//
// Pure, dependency-free Node-22 built-ins, offline-testable. This is the quota
// MATH + the EXEMPTION logic and nothing else: it never touches Supabase, never
// reads a clock it isn't handed, never performs I/O. The one impure-ish entry,
// getQuota(), takes an INJECTED async fetchCount(windowStart) so the whole module
// is exercisable without a database (selftest.mjs proves it).
//
// Generalised over "a countable metered resource" (started tasks, API calls,
// exports, seats consumed, …) — NOT tasks specifically. The caller decides what
// is counted by what its fetchCount counts.
//
// Derived from Tessera's lib/quota.ts (the rolling-window free-tier gate), with
// the Supabase read lifted out into reference/ glue so this stays pure.

/** Verdict reasons — the only four values quota.reason can take. */
export const REASONS = Object.freeze({
  PRO: "pro", // exempt: live Pro subscriber
  ALLOWLIST: "allowlist", // exempt: dev/admin allow-list (by email)
  WITHIN: "within_quota", // counted, still under the limit
  EXCEEDED: "quota", // counted, at/over the limit → block (drives ?reason=quota)
});

/** Free-tier defaults, overridable by config/env. */
export const DEFAULT_LIMIT = 5;
export const DEFAULT_WINDOW_DAYS = 7;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Resolve config from an env-like object. Config, not code — limit/window/allow-
 * list come from the environment, never hardcoded per client. NO secrets here:
 * these are operational tunables, not credentials.
 *
 * @param {Record<string,string|undefined>} [env=process.env]
 * @returns {{limit:number, windowDays:number, allowlist:string[]}}
 */
export function loadConfig(env = process.env) {
  return {
    limit: toPositiveInt(env.QUOTA_LIMIT, DEFAULT_LIMIT),
    windowDays: toPositiveInt(env.QUOTA_WINDOW_DAYS, DEFAULT_WINDOW_DAYS),
    allowlist: parseAllowlist(env.QUOTA_DEV_ALLOWLIST),
  };
}

/** Parse a comma/space/semicolon-separated allow-list into lowercased emails. */
export function parseAllowlist(raw) {
  if (!raw || typeof raw !== "string") return [];
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function toPositiveInt(raw, fallback) {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * The start of the rolling window as an ISO-8601 string: `now - windowDays`.
 * PURE — the caller injects `now` (a Date or epoch-ms), so the boundary is
 * deterministic and testable. This is exactly the value fetchCount filters on
 * (e.g. SQL `created_at > windowStart`).
 *
 * @param {number} windowDays
 * @param {Date|number} [now=Date.now()]
 * @returns {string} ISO timestamp
 */
export function windowStart(windowDays, now = Date.now()) {
  const ms = now instanceof Date ? now.getTime() : Number(now);
  return new Date(ms - windowDays * MS_PER_DAY).toISOString();
}

/**
 * The pure quota decision. Given a COUNT of consumed units in the window and the
 * caller's exemption inputs, decide whether one more is allowed. No clock, no I/O.
 *
 * Exemptions short-circuit the count entirely (unlimited): a live Pro subscriber
 * or an email on the dev allow-list. Allow-list match is case-insensitive and
 * works regardless of subscription state (so dev/admin access survives a billing
 * outage) — mirrors Tessera's UNLIMITED_EMAILS taking precedence over `plan`.
 *
 * @param {object} a
 * @param {number}  a.count      units consumed in the current window
 * @param {number}  a.limit      max units allowed per window (free tier)
 * @param {number}  a.windowDays length of the rolling window (echoed back; not used in math)
 * @param {boolean} [a.isPro]    caller resolved this as a live Pro subscriber
 * @param {string}  [a.userEmail] the caller's email (for the allow-list check)
 * @param {string[]} [a.allowlist] lowercased exempt emails
 * @returns {{allowed:boolean, remaining:number|null, reason:string, count:number, limit:number|null, windowDays:number, exempt:boolean}}
 */
export function evaluateQuota({
  count,
  limit,
  windowDays,
  isPro = false,
  userEmail = null,
  allowlist = [],
}) {
  const email = (userEmail ?? "").toLowerCase();
  const onAllowlist = email !== "" && allowlist.includes(email);

  if (onAllowlist) {
    return unlimited(REASONS.ALLOWLIST, windowDays);
  }
  if (isPro) {
    return unlimited(REASONS.PRO, windowDays);
  }

  const used = Math.max(0, Number(count) || 0);
  const remaining = Math.max(0, limit - used);
  const allowed = remaining > 0;
  return {
    allowed,
    remaining,
    reason: allowed ? REASONS.WITHIN : REASONS.EXCEEDED,
    count: used,
    limit,
    windowDays,
    exempt: false,
  };
}

function unlimited(reason, windowDays) {
  return {
    allowed: true,
    remaining: null, // null == unlimited (not counted)
    reason,
    count: 0,
    limit: null,
    windowDays,
    exempt: true,
  };
}

/**
 * End-to-end quota evaluation with the count INJECTED. The only async entry.
 * Resolves the window boundary, asks the injected fetchCount how many units the
 * user has consumed since then, then applies the pure decision. Takes no
 * Supabase/HTTP dependency itself — see reference/quota.supabase.reference.ts for
 * a concrete fetchCount.
 *
 * `isPro` is resolved by the CALLER (it is subscription-store-specific: e.g.
 * Tessera requires subscription_status ∈ {active,trialing}). The core only trusts
 * the boolean — keeping the "what counts as Pro" policy out of this pure module.
 *
 * @param {object} a
 * @param {(windowStart:string)=>Promise<number>} a.fetchCount  injected counter
 * @param {{email?:string|null, isPro?:boolean}} a.user
 * @param {{limit:number, windowDays:number, allowlist:string[]}} a.cfg
 * @param {Date|number} [a.now=Date.now()]  injected clock (deterministic tests)
 * @returns {Promise<ReturnType<typeof evaluateQuota>>}
 */
export async function getQuota({ fetchCount, user, cfg, now = Date.now() }) {
  if (typeof fetchCount !== "function") {
    throw new TypeError("getQuota: fetchCount must be an injected async function");
  }
  const email = (user?.email ?? "").toLowerCase();
  const isPro = Boolean(user?.isPro);
  const allowlist = cfg.allowlist ?? [];

  // Exempt callers never hit the counter — saves the DB round-trip and means
  // dev/admin + Pro work even if the count source is down.
  const onAllowlist = email !== "" && allowlist.includes(email);
  if (onAllowlist) return unlimited(REASONS.ALLOWLIST, cfg.windowDays);
  if (isPro) return unlimited(REASONS.PRO, cfg.windowDays);

  const start = windowStart(cfg.windowDays, now);
  const count = await fetchCount(start);
  return evaluateQuota({
    count,
    limit: cfg.limit,
    windowDays: cfg.windowDays,
    isPro: false,
    userEmail: email,
    allowlist,
  });
}
