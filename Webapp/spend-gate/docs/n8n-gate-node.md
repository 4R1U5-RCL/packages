# The hosted spend-gate node (doc only — lives on YOUR n8n instance)

This package ships the RPC (`migrations/0001_daily_token_spend.sql`) and the pricing
module (`src/cost.mjs`). The **gate node itself stays hosted** on the studio's n8n
instance and is **never handed to a client** — that hosted enforcement boundary is
the recurring-revenue line (root §8). This file documents the node so it can be
rebuilt or audited; there is no committed `*.workflow.json` here on purpose.

## Where it sits

Insert the gate **before the first paid step** in each workflow that spends money
(the LLM analyse/compose stages and any Firecrawl map/scrape). It aborts the run
*before* a single paid call, so an over-cap day costs nothing.

```
Webhook ─▶ [Get Daily Token Spend] ─▶ [Gate: over cap?] ─┬─ allow ─▶ …paid work…
                  (Supabase RPC)         (IF / Code)      └─ abort ─▶ [Respond 429 over-cap]
```

## Node 1 — Get Daily Token Spend (Supabase / Postgres RPC)

Call the SECURITY DEFINER RPC with the **service-role** credential (the only role
granted EXECUTE). It returns one scalar numeric — wire it so a 0-row day still
yields `0`, never an empty set that drops the flow (the TE-5 failure this RPC fixes):

- **Global backstop:** `POST /rest/v1/rpc/get_daily_token_spend` with body `{}`.
- **Per-user cap:** body `{ "p_user_id": "<uuid-from-event>" }`.

Run both when both caps are configured; the gate trips on whichever bites first.

## Node 2 — Gate (IF / Code node)

Reads the caps from **hosted n8n env only** — never from the client repo, never
from the request body (so a caller can't raise their own cap):

| Env var                  | Meaning                                  | Unset behaviour      |
|--------------------------|------------------------------------------|----------------------|
| `TOKEN_CAP`              | global daily token backstop              | no global cap (off)  |
| `USER_DAILY_TOKEN_CAP`   | per-user daily token cap                 | no per-user cap (off)|

Decision is exactly `src/cost.mjs` `overCap(spend, cap)`:

```js
// inside the n8n Code node
const overCap = (spend, cap) => {
  const c = Number(cap);
  if (!Number.isFinite(c) || c <= 0) return false; // unset/0 → cap disabled
  return (Number(spend) || 0) >= c;                // at-or-over the ceiling → abort
};

const global  = overCap($json.globalSpend, $env.TOKEN_CAP);
const perUser = overCap($json.userSpend,   $env.USER_DAILY_TOKEN_CAP);
if (global || perUser) {
  return [{ json: { abort: true, reason: global ? 'global daily cap' : 'per-user daily cap' } }];
}
return [{ json: { abort: false } }];
```

An unset cap disables that mode — both unset means the gate is inert by design, so
deploying it never silently blocks anyone.

## Node 3 — Respond (over-cap)

On `abort: true`, short-circuit to a `429`-style response and do **not** continue to
the paid nodes. Optionally emit a studio alert (the `notify` package) so the operator
sees the backstop fire.

## Config / secrets

- Caps (`TOKEN_CAP`, `USER_DAILY_TOKEN_CAP`) live in **hosted n8n env**. No secret
  is stored in this package.
- The Supabase service-role key is an n8n **credential**, not committed anywhere here.

## The Phase-4 dependency (be honest)

This node only bites once the workflow actually **writes** `tokens_in` / `tokens_out`
onto `tasks` per run. Until that usage-write lands, the RPC truthfully returns `0`,
`overCap` is always false, and the gate is wired-but-inert. See the README.
