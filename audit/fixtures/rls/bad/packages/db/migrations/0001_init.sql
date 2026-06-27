-- KNOWN-BAD fixture: `seo_events` is created but RLS is NEVER enabled on it.
-- This is the injected bad input. The RLS check must DETECT this table as a
-- violation (negative control must fire). If the check passes this fixture,
-- the check is broken and must NOT be trusted.

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  email text,
  captured jsonb not null default '{}'::jsonb
);
alter table public.leads enable row level security;

create table public.form_submissions (
  id uuid primary key default gen_random_uuid(),
  payload jsonb not null default '{}'::jsonb
);
alter table public.form_submissions enable row level security;

-- VIOLATION: seo_events has no `enable row level security` anywhere.
create table public.seo_events (
  id uuid primary key default gen_random_uuid(),
  path text not null,
  meta jsonb not null default '{}'::jsonb
);
