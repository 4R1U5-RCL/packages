/**
 * stripe.reference.ts — REFERENCE Stripe SDK glue, NOT shipped as-is.
 * ───────────────────────────────────────────────────────────────────────────
 * ⚠️ STATUS: NOT LIVE-WIRED / UNTESTED. Everything in THIS file calls the live
 * Stripe API through the SDK and has NOT been run against real keys. It is
 * reference-only and UNVERIFIED. (The proven, offline part of this package is the
 * CORE: signature verification + event→state mapping — NOT this file.) Wire real
 * keys and run an end-to-end test before relying on any of it.
 * ───────────────────────────────────────────────────────────────────────────
 * SERVER ONLY. Never import from a client component — `STRIPE_SECRET_KEY` must
 * never reach the browser.
 *
 * The Stripe SDK is intentionally NOT vendored by this package. The CLIENT app
 * installs `stripe` and copies this file in, pointing the imports at its own
 * Supabase/types. Lazy construction lets `next build` collect routes that import
 * this without `STRIPE_SECRET_KEY` present at build time.
 *
 * Env: STRIPE_SECRET_KEY (sk_…), STRIPE_PRO_PRICE_ID (price_…).
 */

import Stripe from "stripe";
import type { SupabaseClient, User } from "@supabase/supabase-js";

/**
 * LAZY Stripe handle. The SDK is constructed on first property access, not at
 * import — so a build can collect routes importing this without the secret key.
 * `new Stripe('')` throws, which would otherwise fail the whole build.
 */
let _stripe: Stripe | null = null;
function getStripe(): Stripe {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  _stripe = new Stripe(key);
  return _stripe;
}

export const stripe = new Proxy({} as Stripe, {
  get(_target, prop, receiver) {
    const client = getStripe();
    const value = Reflect.get(client as object, prop, receiver);
    return typeof value === "function" ? value.bind(client) : value;
  },
});

/**
 * Resolve (or lazily create) the Stripe customer for a user and return its id.
 * Looks up `profiles.stripe_customer_id`; if absent, creates a Stripe customer
 * and persists the id back via the SERVICE client (stripe_customer_id is a
 * server-write-only billing column).
 */
export async function ensureStripeCustomer(
  user: User,
  serviceClient: SupabaseClient,
): Promise<string> {
  const { data: profile } = await serviceClient
    .from("profiles")
    .select("stripe_customer_id")
    .eq("user_id", user.id)
    .maybeSingle<{ stripe_customer_id: string | null }>();

  if (profile?.stripe_customer_id) return profile.stripe_customer_id;

  const customer = await stripe.customers.create({
    email: user.email ?? undefined,
    metadata: { user_id: user.id },
  });

  const { error } = await serviceClient
    .from("profiles")
    .update({ stripe_customer_id: customer.id })
    .eq("user_id", user.id);

  if (error) throw new Error(`Failed to persist stripe_customer_id: ${error.message}`);
  return customer.id;
}

/**
 * Create a Checkout Session for the Pro plan. `client_reference_id = user.id` is
 * what the `checkout.session.completed` webhook reads to find the profile row.
 */
export async function createCheckoutSession(opts: {
  user: User;
  customerId: string;
  successUrl: string;
  cancelUrl: string;
}): Promise<string> {
  const priceId = process.env.STRIPE_PRO_PRICE_ID;
  if (!priceId) throw new Error("STRIPE_PRO_PRICE_ID is not set");

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: opts.customerId,
    client_reference_id: opts.user.id, // webhook matches the profile on this.
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
  });

  if (!session.url) throw new Error("Stripe did not return a Checkout URL");
  return session.url;
}

/** Create a Billing Portal session so a user can manage/cancel their subscription. */
export async function createPortalSession(opts: {
  customerId: string;
  returnUrl: string;
}): Promise<string> {
  const session = await stripe.billingPortal.sessions.create({
    customer: opts.customerId,
    return_url: opts.returnUrl,
  });
  return session.url;
}
