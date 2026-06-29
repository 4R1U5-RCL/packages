#!/usr/bin/env node
// selftest.mjs — OFFLINE earned checks (no network, no DB, no creds).
//
// Proves the parts this package actually owns behave before any live wiring exists:
// the pricing math against hand-computed expected values, the overCap gate at its
// boundaries, and that the shipped migration is genuinely a locked-down
// SECURITY DEFINER RPC (text-asserted, not assumed). Exits 0 only if every
// assertion holds — a real green, not a "ran without error".
//
//   node selftest.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  MODEL_PRICING,
  FIRECRAWL_USD_PER_PAGE,
  cost,
  computeTaskUsd,
  overCap,
  formatUsd,
} from './src/cost.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
let n = 0;
const ok = (name) => { n++; process.stdout.write(`  ✓ ${name}\n`); };
const near = (a, b, eps = 1e-12) => Math.abs(a - b) <= eps;

// 1. cost() prices a known model/token input exactly.
{
  // Sonnet $3/$15 per MTok: 1,000,000 in + 500,000 out = 3 + 7.5 = 10.5
  assert.ok(near(cost('claude-sonnet-4-6', 1_000_000, 500_000), 10.5));
  // Haiku $1/$5: 2,000,000 in + 1,000,000 out = 2 + 5 = 7
  assert.ok(near(cost('claude-haiku-4-5', 2_000_000, 1_000_000), 7));
  // Opus $5/$25: 200,000 in + 100,000 out = 1 + 2.5 = 3.5
  assert.ok(near(cost('claude-opus-4-8', 200_000, 100_000), 3.5));
  ok('cost() matches hand-computed USD for each priced model');
}

// 2. Unknown model falls back to Sonnet rates (never a silent $0).
{
  assert.ok(near(cost('gpt-imaginary', 1_000_000, 0), MODEL_PRICING['claude-sonnet-4-6'].in));
  assert.equal(cost('claude-haiku-4-5', 0, 0), 0); // zero tokens → zero, not fallback
  ok('cost() falls back to Sonnet for unknown models, zero tokens cost zero');
}

// 3. computeTaskUsd(): per-stage breakdown + Firecrawl, and the null "not measured" path.
{
  const usd = computeTaskUsd({
    cost_breakdown: [
      { model: 'claude-haiku-4-5', tokens_in: 1_000_000, tokens_out: 0 },   // $1
      { model: 'claude-sonnet-4-6', tokens_in: 0, tokens_out: 1_000_000 },  // $15
    ],
    firecrawl_pages: 10, // 10 * 0.001 = $0.01
  });
  assert.ok(near(usd, 1 + 15 + 10 * FIRECRAWL_USD_PER_PAGE));
  assert.equal(computeTaskUsd(null), null);          // no usage object
  assert.equal(computeTaskUsd({}), null);            // empty → "not captured yet"
  assert.equal(computeTaskUsd({ tokens_in: 0, tokens_out: 0, firecrawl_pages: 0 }), null);
  ok('computeTaskUsd() sums per-model stages + Firecrawl, returns null when unmeasured');
}

// 4. overCap() boundaries: below / exactly-at / above, and disabled caps.
{
  assert.equal(overCap(999, 1000), false);   // below the ceiling → allow
  assert.equal(overCap(1000, 1000), true);   // AT the ceiling → abort (>=)
  assert.equal(overCap(1001, 1000), true);   // above → abort
  // a non-positive / missing / non-finite cap means "no cap configured" → never trips
  assert.equal(overCap(10_000_000, 0), false);
  assert.equal(overCap(10_000_000, null), false);
  assert.equal(overCap(10_000_000, undefined), false);
  assert.equal(overCap(10_000_000, -5), false);
  assert.equal(overCap(10_000_000, NaN), false);
  // spend coerces: missing spend is 0
  assert.equal(overCap(undefined, 1000), false);
  ok('overCap() trips at-or-over the cap; an unset/0/negative cap is disabled');
}

// 5. formatUsd(): cents precision, em-dash for unknown.
{
  assert.equal(formatUsd(0.275), '$0.28');
  assert.equal(formatUsd(0), '$0.00');
  assert.equal(formatUsd(null), '—');
  assert.equal(formatUsd(undefined), '—');
  ok('formatUsd() renders cents and an em-dash when unknown');
}

// 6. The migration is a genuinely locked-down SECURITY DEFINER RPC (asserted on text).
{
  const sql = readFileSync(join(__dir, 'migrations', '0001_daily_token_spend.sql'), 'utf8');
  const lower = sql.toLowerCase();
  assert.match(lower, /create or replace function public\.get_daily_token_spend/);
  assert.match(lower, /security definer/);                 // bypasses RLS by design
  assert.match(lower, /set search_path = public, pg_temp/); // definer hygiene
  assert.match(lower, /returns numeric/);                  // scalar, not a set (TE-5 fix)
  // REVOKE the auto-granted roles by name, not just FROM PUBLIC (the gap TE-5 hit).
  assert.match(lower, /revoke all on function public\.get_daily_token_spend\(uuid\) from public, anon, authenticated/);
  assert.match(lower, /grant execute on function public\.get_daily_token_spend\(uuid\) to service_role/);
  // ...and no EXECUTABLE statement grants to anon/authenticated. Strip `--` comments
  // first so the explanatory prose ("auto-grant execute to anon…") can't fool this.
  const stmts = lower
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n');
  assert.doesNotMatch(stmts, /grant execute[^;]*to[^;]*(anon|authenticated)/);
  ok('migration is SECURITY DEFINER, scalar, REVOKEs public/anon/authenticated, grants service_role only');
}

process.stdout.write(`\nselftest: ${n} checks passed\n`);
