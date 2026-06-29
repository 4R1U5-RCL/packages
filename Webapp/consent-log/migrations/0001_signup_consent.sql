-- =============================================================================
-- consent-log/migrations/0001_signup_consent.sql
--
-- The DB side of the server-enforced GDPR signup consent gate. Adds two columns
-- to the app's per-user `profiles` table to persist the consent the server gate
-- (src/consent.mjs → reference/signup.reference.ts) already enforces:
--
--   * consent_accepted_at — WHEN the user accepted the Privacy Policy + Terms.
--   * consent_version      — WHICH policy version they accepted (the CONSENT_VERSION
--                            constant in src/consent.mjs, e.g. '2026-06-29').
--
-- Together these make the agreement auditable after the fact: GDPR Art. 7(1)
-- requires the controller to be able to DEMONSTRATE that consent was given, and
-- for which version of the terms.
--
-- ---------------------------------------------------------------------------
-- SERVER-WRITE-ONLY — this is the load-bearing property of this migration.
-- ---------------------------------------------------------------------------
-- A consent record a user can write or backdate is worthless as evidence. These
-- two columns MUST only ever be written by the server (the signUp action, via the
-- service-role client, which bypasses RLS + column grants). A signed-in user must
-- never be able to alter their own consent_accepted_at / consent_version.
--
-- Postgres has no "REVOKE this one column" verb: a table-level UPDATE grant
-- (Supabase's default for `authenticated`) covers EVERY column and cannot be
-- narrowed by a column-level revoke. So the carve-out is done the only way that
-- actually works — revoke UPDATE table-wide, then re-grant UPDATE on ONLY the
-- user-editable columns. The consent columns are deliberately absent from that
-- re-grant, so neither `authenticated` nor `anon` can write them. RLS is the
-- second lock (row ownership); the column grant is the first (which columns are
-- writable at all). Both are asserted here so this file is correct read alone.
--
-- Idempotent — safe to re-run. Apply via the Supabase Management API (HTTPS),
-- never the raw Postgres wire.
-- =============================================================================

-- The app-side per-user table. Created here with the minimum shape if absent so
-- this migration stands alone; in a real app `profiles` already exists and the
-- `if not exists` guards make this a no-op against it.
create table if not exists public.profiles (
  user_id   uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  email     text,
  created_at timestamptz not null default now()
);

-- The consent columns. Nullable: a row may exist before consent is stamped, but
-- the server gate guarantees no ACCOUNT is created without a fresh acceptance.
alter table public.profiles
  add column if not exists consent_accepted_at timestamptz,
  add column if not exists consent_version     text;

-- --- RLS (row ownership) -----------------------------------------------------
-- Every table ships row-level security from the start (baseline §5). A user may
-- read/update only their own profile row; the service role (server) is unscoped.
alter table public.profiles enable row level security;
alter table public.profiles force row level security;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- --- Column-level grants (which columns are writable at all) ------------------
-- THE server-write-only carve-out. Strip Supabase's default table-wide UPDATE,
-- then re-grant UPDATE on ONLY the user-editable columns. consent_accepted_at and
-- consent_version are intentionally NOT listed → they are server-write-only.
revoke update on public.profiles from authenticated, anon;
grant  update (full_name, email) on public.profiles to authenticated;

-- anon gets nothing; the row is created server-side.
revoke all on public.profiles from anon;

-- Self-documenting columns (the audit reads these).
comment on column public.profiles.consent_accepted_at is
  'When the user accepted the Privacy Policy + Terms at signup. SERVER-WRITE-ONLY (signUp action, service role) — never in the authenticated UPDATE grant. GDPR Art. 7 evidence.';
comment on column public.profiles.consent_version is
  'Policy version accepted at signup (CONSENT_VERSION in src/consent.mjs). SERVER-WRITE-ONLY — never user-writable, so the agreement cannot be backdated.';
