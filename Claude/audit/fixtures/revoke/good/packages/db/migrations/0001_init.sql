-- KNOWN-GOOD fixture: every PII table strips baseline grants from anon AND
-- public before any explicit grant. The revoke check must PASS this (zero
-- violations).

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  email text,
  phone text,
  captured jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
revoke all on public.leads from anon, public;
grant insert on public.leads to authenticated;

create table public.form_submissions (
  id uuid primary key default gen_random_uuid(),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
revoke all on public.form_submissions from anon, public;
grant insert on public.form_submissions to authenticated;

create table public.seo_events (
  id uuid primary key default gen_random_uuid(),
  path text not null,
  meta jsonb not null default '{}'::jsonb
);
revoke all on public.seo_events from anon, public;
grant insert on public.seo_events to authenticated;
