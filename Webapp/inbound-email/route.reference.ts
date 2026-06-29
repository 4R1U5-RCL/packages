/**
 * route.reference.ts — REFERENCE wiring, NOT shipped as-is.
 * ───────────────────────────────────────────────────────────────────────────
 * This file shows how a client's Next.js app wires the package's CORE modules
 * (verify → fetch → forward) into an App Router route handler. The CLIENT copies
 * this to `app/api/inbound/route.ts` and points the imports at wherever the
 * package is installed. It is REFERENCE because it is the only part that touches
 * the framework (Next `Request`/`Response`, the `nodejs` runtime); the package
 * itself stays framework-free and offline-testable.
 *
 * ⚠️ CRITICAL — ADD THE ROUTE TO middleware PUBLIC_PATHS.
 * Resend POSTs here UNAUTHENTICATED (it has no session cookie). If `/api/inbound`
 * sits behind the app's auth middleware, the middleware 307-redirects the POST to
 * `/sign-in` and Resend never reaches the handler — inbound mail silently never
 * forwards. This bit us once (an ERRORS finding). The route does its OWN Svix
 * signature verification, so it is safe to make public. In `middleware.ts`:
 *
 *     const PUBLIC_PATHS = [
 *       // ...auth + marketing + legal...
 *       '/api/inbound',  // Resend POSTs unauthenticated; route self-verifies Svix
 *     ];
 *
 * Confirm with: `curl -i https://<domain>/api/inbound` returns 400 (bad
 * signature), NOT 307 (redirect to sign-in).
 *
 * Flow:
 *   1. Resend receives mail (root MX → inbound-smtp.us-east-1.amazonaws.com) and
 *      POSTs an `email.received` webhook here.
 *   2. We verify the Svix signature over the RAW body (never parse first).
 *   3. The webhook carries metadata only → fetch the full message by id.
 *   4. Re-send it from INBOUND_FORWARD_FROM to INBOUND_FORWARD_TO with reply_to
 *      set to the original sender.
 */

// Adjust this path to the installed package location:
import { verify } from "inbound-email/src/verify.mjs";
import {
  parseAllowList,
  bareAddrs,
  recipientAllowed,
  buildForwardPayload,
} from "inbound-email/src/forward.mjs";
import { fetchReceivedEmail, sendEmail } from "inbound-email/src/resend.mjs";

// node:crypto + raw body → must run on the Node.js runtime, not Edge.
export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  const raw = await req.text(); // RAW bytes — required before any JSON.parse

  const secret = process.env.RESEND_WEBHOOK_SECRET ?? "";
  const sendKey = process.env.RESEND_API_KEY ?? "";              // send-scoped is enough
  const fullKey = process.env.RESEND_FULL_ACCESS_API_KEY ?? sendKey; // receiving:read
  const forwardTo = process.env.INBOUND_FORWARD_TO ?? "";
  const forwardFrom = process.env.INBOUND_FORWARD_FROM ?? "";
  const allowList = parseAllowList(process.env.INBOUND_FORWARD_ONLY);

  const result = verify(raw, req.headers, secret);
  if (!result.ok) {
    // 400 (not 307!). If you see a redirect here, the route is not in PUBLIC_PATHS.
    return new Response(`Invalid signature: ${result.reason}`, { status: 400 });
  }

  let event: { type?: string; data?: { email_id?: string; to?: string[] } };
  try {
    event = JSON.parse(raw);
  } catch {
    return new Response("Bad payload", { status: 400 });
  }

  // ACK anything that isn't an inbound receipt so Resend stops retrying.
  if (event.type !== "email.received" || !event.data?.email_id) {
    return new Response(null, { status: 200 });
  }

  // Allow-list on the lightweight webhook payload, before the fetch round-trip.
  if (!recipientAllowed(bareAddrs(event.data.to), allowList)) {
    return new Response(null, { status: 200 });
  }

  let mail;
  try {
    mail = await fetchReceivedEmail(event.data.email_id, fullKey);
  } catch {
    // 502 → Resend retries; the message is stored on their side regardless.
    return new Response("Failed to fetch received email", { status: 502 });
  }

  try {
    await sendEmail(
      buildForwardPayload(mail, { from: forwardFrom, to: forwardTo }),
      sendKey,
    );
  } catch {
    return new Response("Forward send failed", { status: 502 });
  }

  return new Response(null, { status: 200 });
}
