/**
 * webhook.route.reference.ts — REFERENCE wiring, NOT shipped as-is.
 * ───────────────────────────────────────────────────────────────────────────
 * ⚠️ STATUS: NOT LIVE-WIRED / UNTESTED. This route has not been run against a
 * live Stripe webhook. Only the CORE it calls (verify-webhook + apply-event) is
 * proven by the offline selftest. Wire real keys + a Stripe webhook endpoint and
 * run an end-to-end test before relying on it.
 * ───────────────────────────────────────────────────────────────────────────
 * Shows how a client's Next.js App Router app wires the package CORE
 * (verify → apply → service-role upsert) into a route handler. The CLIENT copies
 * this to `app/api/stripe/webhook/route.ts` and points the imports at the
 * installed package. REFERENCE because it touches the framework (Next
 * `Request`/`Response`, the `nodejs` runtime) and Supabase; the CORE stays
 * framework-free and offline-testable.
 *
 * ⚠️ CRITICAL — ADD THE ROUTE TO middleware PUBLIC_PATHS.
 * Stripe POSTs here UNAUTHENTICATED (no session cookie). If
 * `/api/stripe/webhook` sits behind the app's auth middleware, the middleware
 * 307-redirects the POST to `/sign-in` and Stripe never reaches the handler —
 * subscription state silently never updates. The route does its OWN signature
 * verification, so it is safe to make public. In `middleware.ts`:
 *
 *     const PUBLIC_PATHS = [
 *       // ...auth + marketing + legal...
 *       '/api/stripe/webhook', // Stripe POSTs unauthenticated; route self-verifies
 *     ];
 *
 * Confirm with: `curl -i https://<domain>/api/stripe/webhook` returns 400 (bad
 * signature), NOT 307 (redirect to sign-in).
 *
 * Flow:
 *   1. Stripe POSTs an event here.
 *   2. Verify the signature over the RAW body (never JSON.parse first).
 *   3. Map the event to an ABSOLUTE profile-state patch (idempotent).
 *   4. Apply it with the SERVICE-ROLE client (billing columns are server-write-only).
 */

// Adjust these paths to the installed package location:
import { constructEvent } from "stripe-billing/src/verify-webhook.mjs";
import { applyEvent } from "stripe-billing/src/apply-event.mjs";
// Your app's service-role Supabase factory (bypasses RLS — server only):
import { createServiceClient } from "@/lib/supabase";

// node:crypto + raw body → must run on the Node.js runtime, not Edge.
export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  const raw = await req.text(); // RAW bytes — required before any JSON.parse.
  const sig = req.headers.get("stripe-signature");
  const secret = process.env.STRIPE_WEBHOOK_SECRET ?? "";

  let event: { type: string; data: { object: Record<string, unknown> } };
  try {
    // Throws on a bad/stale/forged signature — same contract as Stripe's SDK.
    event = constructEvent(raw, sig, secret);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid signature.";
    // 400 (not 307!). A redirect here means the route is not in PUBLIC_PATHS.
    return new Response(message, { status: 400 });
  }

  const mapped = applyEvent(event);
  // Unhandled event type → ACK so Stripe stops retrying.
  if (!mapped || !mapped.match.value) {
    return new Response(null, { status: 200 });
  }

  const supabase = createServiceClient();
  const { error } = await supabase
    .from("profiles")
    .update(mapped.patch)
    .eq(mapped.match.column, mapped.match.value);

  if (error) {
    // 500 → Stripe retries; the patch is absolute, so a retry is safe.
    return new Response(`DB update failed: ${error.message}`, { status: 500 });
  }

  return new Response(null, { status: 200 });
}
