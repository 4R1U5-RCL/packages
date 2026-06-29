-- activity-feed / 0001_activity_events.sql
--
-- A structured, per-user in-app audit trail. One append-only row per logged
-- event, written from server actions through the logEvent() seam. This is app
-- data Shopify does not own (baseline §8.1, shape 1) — it never mirrors
-- commercial state, so it is a legitimate Supabase table.
--
-- Security contract (the whole reason this is a table and not a console.log):
--   * RLS ON — owner-scoped reads: a user sees ONLY their own events.
--   * INSERTS are server-only — written with the service role, which bypasses
--     RLS. There is deliberately NO insert policy for anon/authenticated, so a
--     browser-side client physically cannot forge an audit row.
--   * Append-only — no update/delete policy exists, so the trail is immutable
--     from the client side (an audit log you can edit is not an audit log).

-- Note vs. the current Tessera table: this adds `type` (closed vocabulary) and
-- `meta` (jsonb), and DROPS the bespoke `task_id` column — task context now
-- rides in `meta` (the jsonb capture column that absorbs per-client variation,
-- packages/db §"Fixed schema, not forked"). `ts` keeps Tessera's column name.
create table public.activity_events (
  id      uuid primary key default gen_random_uuid(),
  ts      timestamptz not null default now(),
  user_id uuid not null references auth.users (id) on delete cascade,
  level   text not null check (level in ('info', 'success', 'warning', 'error')),
  type    text not null,
  message text not null,
  meta    jsonb not null default '{}'::jsonb
);

create index activity_events_user_id_ts_idx
  on public.activity_events (user_id, ts desc);

-- RLS on, and strip the baseline grants from anon AND public before any explicit
-- grant — the same REVOKE discipline the studio enforces on every PII table.
alter table public.activity_events enable row level security;
revoke all on public.activity_events from anon, public;

-- READ: owner-scoped. A user can SELECT only rows they own. This is the only
-- policy on the table, so by RLS default every other verb (insert/update/delete)
-- is denied for anon/authenticated. auth.uid() = user_id is the owner predicate.
create policy activity_events_select_own
  on public.activity_events
  for select
  to authenticated
  using (auth.uid() = user_id);

-- Grant SELECT to authenticated so the policy above can apply (the policy still
-- narrows it to own-rows). No INSERT/UPDATE/DELETE grant is given to anyone but
-- the service role, which bypasses RLS entirely — that is the "server-only
-- insert" boundary, enforced by the absence of any write path here.
grant select on public.activity_events to authenticated;
