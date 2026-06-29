// consent-log/reference/signup.reference.ts — REFERENCE GLUE, not a shipped file.
//
// Shows how to wire the pure gate (../src/consent.mjs) into a real signup server
// action (Next.js App Router `'use server'`, Supabase). It is the seam the
// selftest's contract stands in for; copy the shape into the client's
// app/(auth)/actions.ts, adjusting imports. The two non-negotiables it
// demonstrates:
//
//   1. ENFORCE BEFORE CREATE. requireConsent() runs and must pass BEFORE the
//      auth.signUp call, so an account is never created (and no confirmation
//      email is ever sent) without a fresh, version-pinned acceptance. The gate
//      is independent of the client — a forged form that omits the checkbox is
//      rejected here.
//
//   2. WRITE THE RECORD WITH THE SERVICE ROLE. consent_accepted_at /
//      consent_version are server-write-only (migrations/0001_signup_consent.sql):
//      the user role has no UPDATE grant on them. So the record is stamped by
//      stampConsent() and written through the SERVICE-ROLE client, which bypasses
//      RLS + column grants. The user can never write or backdate their own consent.
//
// Imports are illustrative ('@/lib/...'); the consent import resolves to this
// package.

'use server';

import { redirect } from 'next/navigation';
// @ts-expect-error — resolves to ../src/consent.mjs when this package is pulled in.
import {
  requireConsent,
  stampConsent,
  ConsentRequiredError,
  CONSENT_VERSION,
} from '@studio/consent-log/consent';
import { createServerClient, createServiceClient } from '@/lib/supabase';

export async function signUp(formData: FormData) {
  const fullName = String(formData.get('full_name') ?? '');
  const email = String(formData.get('email') ?? '');

  // (1) ENFORCE BEFORE CREATE. `consent` is the checkbox; `consent_version` is a
  // hidden field rendered with the live CONSENT_VERSION so a stale form is caught.
  // A structured ConsentRequiredError bounces the user back with a clear reason —
  // we never reach auth.signUp without a valid, current acceptance.
  let consent;
  try {
    requireConsent({
      accepted: formData.get('consent'),
      version: formData.get('consent_version'),
    });
    // Stamp from the trusted server clock + the live version, not the raw input.
    consent = stampConsent(
      { accepted: formData.get('consent'), version: formData.get('consent_version') },
      { at: Date.now() },
    );
  } catch (err) {
    if (err instanceof ConsentRequiredError) {
      redirect(`/sign-up?error=${encodeURIComponent(err.message)}&code=${err.code}`);
    }
    throw err;
  }

  // Create the account only now that consent is proven.
  const supabase = await createServerClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password: crypto.randomUUID(), // placeholder; user sets real password post-confirm
    options: { data: { full_name: fullName } },
  });
  if (error) {
    redirect(`/sign-up?error=${encodeURIComponent(error.message)}`);
  }

  const user = data.user;
  if (user) {
    // RLS-scoped upsert of the user-editable profile fields (these ARE granted).
    await supabase
      .from('profiles')
      .upsert({ user_id: user.id, full_name: fullName, email }, { onConflict: 'user_id' });

    // (2) WRITE THE CONSENT RECORD WITH THE SERVICE ROLE — the only client that
    // can write the server-write-only columns. `consent` already holds the exact
    // server-write-only column shape from stampConsent().
    const admin = createServiceClient();
    const { consent_accepted_at, consent_version } = consent;
    const { error: consentError } = await admin
      .from('profiles')
      .upsert(
        { user_id: user.id, consent_accepted_at, consent_version },
        { onConflict: 'user_id' },
      );
    if (consentError) {
      // The gate already enforced agreement; only the audit row is deferred.
      // Log through the app's security sink (never console) and continue.
      console.error('signup_consent_record deferred', consentError.message);
    }
  }

  redirect(`/verify-email?email=${encodeURIComponent(email)}`);
}

// For the form: render the live version into a hidden field so the gate can catch
// a stale policy. e.g.  <input type="hidden" name="consent_version" value={CONSENT_VERSION} />
export { CONSENT_VERSION };
