// usage-quota/src/enforce.mjs — enforce the quota at the ACTION boundary.
//
// The signal is a redirect to the billing page with `?reason=quota`, exactly as
// Tessera's startTask() does: `redirect('/billing?reason=quota')`. This module is
// the seam between the pure decision (quota.mjs) and a framework's control flow.
//
// Two flavours, same decision:
//   - enforceQuota(quota)  THROWS QuotaExceededError when over — use it where the
//     framework interrupts via throw (Next.js Server Actions: redirect() itself
//     throws; mirror that so the action body below the gate never runs).
//   - quotaSignal(quota)   RETURNS a signal object or null — for callers that want
//     to branch on a value instead of catching (APIs returning 402/302, RSC, etc.).
//
// Pure: builds a string, makes a decision, no I/O. Node-22 built-ins only.

/** Default billing path + reason; override per app via opts. */
export const DEFAULT_BILLING_PATH = "/billing";
export const DEFAULT_REASON = "quota";

/** Thrown by enforceQuota when the caller is over quota. Carries the redirect
 *  target and the full quota verdict so the boundary can act or log. */
export class QuotaExceededError extends Error {
  /** @param {string} redirect @param {object} quota */
  constructor(redirect, quota) {
    super(`usage-quota: over limit — redirect to ${redirect}`);
    this.name = "QuotaExceededError";
    this.redirect = redirect;
    this.quota = quota;
  }
}

/**
 * Build the billing redirect URL, e.g. `/billing?reason=quota`.
 * @param {{billingPath?:string, reason?:string}} [opts]
 */
export function quotaRedirectUrl({
  billingPath = DEFAULT_BILLING_PATH,
  reason = DEFAULT_REASON,
} = {}) {
  const sep = billingPath.includes("?") ? "&" : "?";
  return `${billingPath}${sep}reason=${encodeURIComponent(reason)}`;
}

/**
 * Non-throwing variant: returns a redirect signal when over quota, else null.
 * @param {{allowed:boolean}} quota  a verdict from evaluateQuota/getQuota
 * @param {{billingPath?:string, reason?:string}} [opts]
 * @returns {{redirect:string, quota:object}|null}
 */
export function quotaSignal(quota, opts) {
  if (quota?.allowed) return null;
  return { redirect: quotaRedirectUrl(opts), quota };
}

/**
 * Throwing variant for the action boundary. If the caller is over quota, throws
 * QuotaExceededError (so nothing after the gate runs); otherwise returns the
 * quota verdict unchanged for convenient chaining.
 *
 *   const quota = await getQuota({ fetchCount, user, cfg });
 *   enforceQuota(quota);            // throws → action aborts, caller redirects
 *   await startTheMeteredThing();   // only reached when allowed
 *
 * @param {{allowed:boolean}} quota
 * @param {{billingPath?:string, reason?:string}} [opts]
 * @returns {object} the same quota when allowed
 */
export function enforceQuota(quota, opts) {
  const sig = quotaSignal(quota, opts);
  if (sig) throw new QuotaExceededError(sig.redirect, quota);
  return quota;
}
