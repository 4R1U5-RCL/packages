// spend-gate/src/cost.mjs — the single source of pricing truth for the gate.
//
// Computes the real USD cost of paid work (LLM tokens + Firecrawl pages) from the
// raw usage the hosted n8n workflow records. Pricing lives HERE and nowhere else:
// n8n writes raw counts, this module prices them, so the two can never drift
// (mirrors the Tessera webapp's lib/cost.ts, PLAN_SPEND_QUOTA.md Phase 4).
//
// Node 22 built-ins only. No npm deps. Pure + offline-testable: every export is a
// deterministic function of its inputs — no clock, no env, no I/O — so selftest.mjs
// can assert the math without any live wiring. Confirm rates against the provider
// dashboards before trusting a number in production.

/** Claude per-MTok pricing (USD), input/output. Keep in sync with the API.
 *  Bare model names, matching what the n8n workflow records on each stage. */
export const MODEL_PRICING = {
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
  'claude-opus-4-8': { in: 5, out: 25 },
};

/** Fallback when a stage's model isn't in the table (priced as Sonnet, the
 *  workhorse) — a conservative estimate, never a silent $0. */
export const FALLBACK_PRICING = { in: 3, out: 15 };

/** Firecrawl: USD per page (≈1 credit/page). Confirm against the actual plan. */
export const FIRECRAWL_USD_PER_PAGE = 0.001;

/**
 * USD cost of ONE model stage from its token counts.
 * @param {string} model               bare model name (keys of MODEL_PRICING)
 * @param {number} inputTokens         prompt tokens
 * @param {number} outputTokens        completion tokens
 * @returns {number} USD
 */
export function cost(model, inputTokens = 0, outputTokens = 0) {
  const price = (model && MODEL_PRICING[model]) || FALLBACK_PRICING;
  const tin = Number(inputTokens) || 0;
  const tout = Number(outputTokens) || 0;
  return (tin / 1_000_000) * price.in + (tout / 1_000_000) * price.out;
}

/**
 * Total USD for a task. Prefers the per-stage breakdown (each stage priced by its
 * own model); falls back to aggregate tokens at the fallback rate when no breakdown
 * is present. Returns null when there is no usage data captured yet — the honest
 * "not measured" signal, distinct from a real $0.
 *
 * @param {{tokens_in?:number, tokens_out?:number, firecrawl_pages?:number,
 *          cost_breakdown?:Array<{model?:string, tokens_in?:number, tokens_out?:number}>}} usage
 * @returns {number|null}
 */
export function computeTaskUsd(usage) {
  if (!usage) return null;

  const hasBreakdown =
    Array.isArray(usage.cost_breakdown) && usage.cost_breakdown.length > 0;
  const hasAggregate =
    (usage.tokens_in ?? 0) > 0 || (usage.tokens_out ?? 0) > 0;
  const hasFirecrawl = (usage.firecrawl_pages ?? 0) > 0;
  if (!hasBreakdown && !hasAggregate && !hasFirecrawl) return null;

  const llmUsd = hasBreakdown
    ? usage.cost_breakdown.reduce(
        (sum, s) => sum + cost(s.model, s.tokens_in, s.tokens_out),
        0,
      )
    : cost(undefined, usage.tokens_in, usage.tokens_out);

  const firecrawlUsd = (usage.firecrawl_pages ?? 0) * FIRECRAWL_USD_PER_PAGE;
  return llmUsd + firecrawlUsd;
}

/**
 * The gate predicate. PURE — the hosted n8n node reads today's accumulated `spend`
 * from the RPC and the `cap` from hosted env, then calls this to decide abort/allow.
 *
 * Semantics:
 *   - A non-positive / null / undefined / non-finite `cap` means NO CAP CONFIGURED
 *     → the gate is disabled → never over-cap (returns false). This is the inert
 *     default: shipping the package does not silently block anyone.
 *   - Otherwise over-cap is `spend >= cap`: reaching the ceiling blocks the NEXT
 *     unit of paid work, so the cap is a hard ceiling, not a soft target.
 *
 * @param {number} spend  today's accumulated spend (same unit as cap: tokens or USD)
 * @param {number|null|undefined} cap
 * @returns {boolean} true → abort (over cap), false → allow
 */
export function overCap(spend, cap) {
  const c = Number(cap);
  if (!Number.isFinite(c) || c <= 0) return false; // no cap configured → disabled
  const s = Number(spend) || 0;
  return s >= c;
}

/** Format a USD amount for display (cents precision). `$0.27`; `—` when unknown. */
export function formatUsd(usd) {
  if (usd === null || usd === undefined) return '—';
  return `$${Number(usd).toFixed(2)}`;
}
