-- =============================================================================
-- spend-gate/migrations/0001_daily_token_spend.sql
--
-- The SECURITY DEFINER RPC the hosted spend-gate node calls before any paid
-- LLM/scrape work. Returns TODAY's total token spend (tokens_in + tokens_out) as a
-- SCALAR numeric — 0 when no rows match, NEVER an empty set.
--
-- Why a scalar matters (the original Tessera TE-5 / BUG-32 failure): the old n8n
-- gate used a `supabase/getAll` node that DROPPED the entire flow on a 0-row day,
-- so on a quiet day the gate disconnected and the cap went unenforced. PostgREST
-- always returns exactly one numeric from this RPC, so the gate node can compare it
-- directly without the 0-row drop. (Apply over HTTPS via the Supabase Management
-- API — the Postgres wire is unreachable in this environment, PAT-5.)
--
-- Serves BOTH gate modes (tokens, not USD — the gate counts raw tokens):
--   * GLOBAL daily backstop  — call with `{}`               (p_user_id IS NULL → all tasks)
--   * PER-USER daily cap      — call with `{"p_user_id":"<uuid>"}` (filters that user)
-- The global mode is the infra-cost circuit breaker; the per-user mode is a budget
-- per account.
--
-- SECURITY DEFINER so it can aggregate across ALL rows regardless of caller. It is
-- granted to service_role ONLY (the hosted workflow's role) — NOT to anon /
-- authenticated — so a signed-in user can never read another user's (or the global)
-- spend through it. `stable` since it only reads. Idempotent (create or replace).
--
-- Assumes a `public.tasks` table with `tokens_in`, `tokens_out` (int), `created_at`
-- (timestamptz) and `user_id` (uuid). See README "Phase-4 gap": those token columns
-- must be POPULATED by the workflow before the cap can bite — until then this RPC
-- truthfully returns 0 and the gate never trips.
-- =============================================================================

create or replace function public.get_daily_token_spend(p_user_id uuid default null)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
           sum(coalesce(tokens_in, 0) + coalesce(tokens_out, 0)),
           0
         )::numeric
  from public.tasks
  where created_at >= date_trunc('day', now())
    and (p_user_id is null or user_id = p_user_id);
$$;

comment on function public.get_daily_token_spend(uuid) is
  'spend-gate: today''s token spend (tokens_in+tokens_out) as a scalar. NULL arg = global backstop; a user_id = that user''s daily total. service_role only.';

-- Supabase's default privileges auto-grant EXECUTE to anon + authenticated on any
-- new function in `public`. `REVOKE ... FROM PUBLIC` does NOT undo those explicit
-- role grants, so revoke them by name too — otherwise this SECURITY DEFINER
-- aggregate (which bypasses RLS) would let anon/authenticated read any user's, or
-- the global, daily spend. End state: service_role only.
revoke all on function public.get_daily_token_spend(uuid) from public, anon, authenticated;
grant execute on function public.get_daily_token_spend(uuid) to service_role;
