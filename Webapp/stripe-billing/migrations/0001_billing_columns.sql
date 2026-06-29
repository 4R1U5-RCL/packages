-- 0001_billing_columns.sql — add Stripe billing state to `profiles` as
-- SERVER-WRITE-ONLY columns.
--
-- These columns are the app's mirror of Stripe subscription state. They are
-- written ONLY by the webhook handler using the Supabase SERVICE-ROLE key (which
-- bypasses RLS). An end user must NEVER be able to set their own `plan` or
-- subscription status, so the `authenticated` role is granted UPDATE on its
-- user-editable columns ONLY — the billing columns are deliberately excluded.
--
-- The grant pattern (REVOKE broad UPDATE, then GRANT UPDATE on an explicit column
-- allow-list) is the discipline that stops a billing column from silently
-- becoming user-writable later. RLS is enabled so row visibility is owner-scoped.

-- 1. Billing columns (idempotent add).
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS plan                   text        NOT NULL DEFAULT 'free',
  ADD COLUMN IF NOT EXISTS stripe_customer_id     text,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id text,
  ADD COLUMN IF NOT EXISTS subscription_status    text,
  ADD COLUMN IF NOT EXISTS current_period_end     timestamptz;

-- Look up a profile fast by its Stripe customer id (webhook match path).
CREATE INDEX IF NOT EXISTS profiles_stripe_customer_id_idx
  ON public.profiles (stripe_customer_id);

-- 2. Row-level security ON. Every read/write is owner-scoped; the service role
--    (webhook) bypasses RLS by design.
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS profiles_select_own ON public.profiles;
CREATE POLICY profiles_select_own
  ON public.profiles
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS profiles_update_own ON public.profiles;
CREATE POLICY profiles_update_own
  ON public.profiles
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- 3. Column-level privilege: revoke broad UPDATE, then re-grant ONLY the
--    user-editable columns. The five billing columns are intentionally absent
--    from this list, so an authenticated user cannot write them even on their own
--    row. (REVOKE discipline — the gap that let Tessera's DEFECT-1 through.)
REVOKE UPDATE ON public.profiles FROM authenticated;

GRANT UPDATE (
  display_name,
  avatar_url
) ON public.profiles TO authenticated;

-- NOTE: billing columns (plan, stripe_customer_id, stripe_subscription_id,
-- subscription_status, current_period_end) are NEVER added to the GRANT above.
-- They are mutated exclusively by the service-role webhook handler.
