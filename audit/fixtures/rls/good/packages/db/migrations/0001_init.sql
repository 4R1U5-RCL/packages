-- KNOWN-GOOD fixture: every table enables row-level security.
-- The RLS check must PASS this (zero violations).

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  email text,
  phone text,
  captured jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
alter table public.leads enable row level security;

create table public.form_submissions (
  id uuid primary key default gen_random_uuid(),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
alter table public.form_submissions enable row level security;

create table public.seo_events (
  id uuid primary key default gen_random_uuid(),
  path text not null,
  meta jsonb not null default '{}'::jsonb
);
alter table public.seo_events enable row level security;

create table public.dashboard_state (
  user_id uuid primary key,
  state jsonb not null default '{}'::jsonb
);
alter table public.dashboard_state enable row level security;
