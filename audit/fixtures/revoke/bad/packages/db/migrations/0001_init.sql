-- KNOWN-BAD fixture: `seo_events` is created and granted to anon but its
-- baseline grants are NEVER revoked from anon/public. This is the injected bad
-- input — PII readable behind a fine-looking policy (the Tessera DEFECT-1
-- class). The revoke check must DETECT seo_events as a violation (negative
-- control must fire). leads/form_submissions are done correctly, so ONLY
-- seo_events should be flagged. If the check passes this fixture, it is broken
-- and must NOT be trusted.

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  email text,
  captured jsonb not null default '{}'::jsonb
);
revoke all on public.leads from anon, public;
grant insert on public.leads to authenticated;

create table public.form_submissions (
  id uuid primary key default gen_random_uuid(),
  payload jsonb not null default '{}'::jsonb
);
revoke all on public.form_submissions from anon, public;
grant insert on public.form_submissions to authenticated;

-- VIOLATION: seo_events is granted to anon but never revoked from anon/public.
create table public.seo_events (
  id uuid primary key default gen_random_uuid(),
  path text not null,
  meta jsonb not null default '{}'::jsonb
);
grant insert on public.seo_events to anon, authenticated;
