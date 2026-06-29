# spend-gate — daily token / cost cap for paid workflow runs

A self-contained, reusable package: the **pricing truth** and the **DB-side spend
read** behind a daily LLM/scrape budget cap. A `SECURITY DEFINER` RPC,
`get_daily_token_spend()`, returns today's accumulated token spend (a global
backstop, or a single user's total); the studio's hosted n8n workflow calls it
before any paid step and **aborts over-cap**. The gate node stays hosted — this
package ships only what the app/DB side owns.

> Modelled on the Tessera webapp's TE-5 fix (`lib/cost.ts` + `0004_get_daily_token_spend.sql`).
> Consumed by pulling a pinned version — never copy-forked into a client repo.

```
spend-gate/
├── src/cost.mjs                       the single pricing-truth module (Node 22, no deps)
├── migrations/0001_daily_token_spend.sql   the SECURITY DEFINER spend-read RPC
├── docs/n8n-gate-node.md              the HOSTED gate node (doc only — stays on your n8n)
└── selftest.mjs                       offline earned checks (math + boundaries + migration lock)
```

## The three pieces

1. **`src/cost.mjs` — pricing, in one place.** `MODEL_PRICING` (Sonnet $3/$15,
   Haiku $1/$5, Opus $5/$25 per MTok), `FIRECRAWL_USD_PER_PAGE`,
   `cost(model, inputTokens, outputTokens)`, `computeTaskUsd(usage)`, and the pure
   gate predicate `overCap(spend, cap)`. n8n records **raw** counts; this module
   **prices** them — so the workflow and the app can never drift. Pure functions,
   no clock/env/I/O, so the math is provable offline.

2. **`migrations/0001_daily_token_spend.sql` — the spend read.**
   `get_daily_token_spend(p_user_id uuid default null)` returns today's
   `tokens_in + tokens_out` as a **scalar numeric** — `0` on a 0-row day, never an
   empty set. `SECURITY DEFINER` (aggregates across all rows), granted to
   `service_role` **only** — `REVOKE`d from `public`, `anon`, `authenticated` by
   name (Supabase auto-grants the latter two, and `REVOKE … FROM PUBLIC` does *not*
   undo those explicit grants — the exact gap the original Tessera fix closed).
   Call `{}` for the global backstop, `{"p_user_id": "<uuid>"}` for a per-user cap.

3. **`docs/n8n-gate-node.md` — the hosted enforcement, documented.** The node reads
   `TOKEN_CAP` / `USER_DAILY_TOKEN_CAP` from **hosted n8n env**, calls the RPC with
   the service-role credential, and applies `overCap()` to abort before any paid
   call. It runs on your infrastructure and is not a client deliverable (see Boundary).

## Config (env, no secrets)

| Var                    | Where        | Meaning                                   |
|------------------------|--------------|-------------------------------------------|
| `TOKEN_CAP`            | hosted n8n   | global daily token backstop (unset = off) |
| `USER_DAILY_TOKEN_CAP` | hosted n8n   | per-user daily token cap (unset = off)    |

Caps live only in the hosted env so a caller can't raise their own. An unset cap
disables that mode; both unset means the gate is inert by design. The package
itself stores no secret (the Supabase service-role key is an n8n credential).

## Honest state — the Phase-4 gap (caps are currently inert)

**The gate is wired but does not yet bite.** Per the Tessera TE-5 finding, the RPC
is applied and verified, but the cap only enforces once the workflow actually
**writes** `tokens_in` / `tokens_out` onto `tasks` per run. Until that usage-write
lands:

- `get_daily_token_spend()` truthfully returns `0` (no token columns populated),
- `overCap(0, cap)` is always `false`, so
- the gate node never aborts — it is **wired-but-inert**.

This is the real partial state, not a TODO to paper over. To make caps bite:
(1) have the workflow record raw `tokens_in`/`tokens_out` (and `firecrawl_pages`)
per run, then (2) set `TOKEN_CAP` / `USER_DAILY_TOKEN_CAP` in the hosted env. Only
then is the backstop live.

## Apply the migration

Over HTTPS via the Supabase Management API (the Postgres wire is unreachable in the
studio environment, and a scalar SECURITY DEFINER RPC needs a privileged apply):
`POST /v1/projects/{ref}/database/query` with the migration body. Re-runnable
(`create or replace` + idempotent grants).

## Prove it

```bash
node selftest.mjs
```

Offline, no creds: asserts the cost math against hand-computed values, the
`overCap` boundaries (below / at / above the cap, and disabled caps), and that the
shipped migration really is `SECURITY DEFINER` with `public`/`anon`/`authenticated`
revoked and `service_role`-only execute.

## Boundary

The **gate node stays hosted** on the studio's n8n instance and is never handed to
a client — that hosted enforcement is the recurring-revenue line. This package ships
the RPC migration, the pricing module, and a *document* of the node — never the live
workflow definition.
