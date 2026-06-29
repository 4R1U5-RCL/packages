// src/apply-event.mjs — Stripe event → ABSOLUTE profile-state patch (CORE).
//
// PURE and dependency-free (Node 22 built-ins only). Given one verified Stripe
// event object, return the profile-state patch to apply, plus the row selector
// to apply it against. The patch is ABSOLUTE state — every value is a full
// replacement, NEVER a delta/increment — which is what makes redelivery safe:
// applying the SAME event twice yields the SAME end state (idempotent).
//
// Handled events:
//   checkout.session.completed              → flip to pro, link customer + sub
//   customer.subscription.created/updated   → authoritative status + period
//   customer.subscription.deleted           → downgrade to free, status canceled
//   invoice.paid                            → keep pro, refresh period
//   invoice.payment_failed                  → status past_due (no auto-downgrade)
// Anything else → null (caller ACKs 200 and ignores, so Stripe stops retrying).
//
// The patch only ever contains keys the event AUTHORITATIVELY carries, so a
// later, more-specific event (e.g. subscription.updated) is never clobbered by a
// null written from an event that didn't know that field.

/** Stripe subscription statuses that grant the paid plan. */
export const ACTIVE_STATUSES = ["active", "trialing"];

const BILLING_COLUMNS = [
  "plan",
  "stripe_customer_id",
  "stripe_subscription_id",
  "subscription_status",
  "current_period_end",
];

/** Convert a Stripe unix timestamp (seconds) to an ISO string, or null. */
function toIso(unixSeconds) {
  return unixSeconds ? new Date(unixSeconds * 1000).toISOString() : null;
}

/** A Stripe id field may be a bare id string OR an expanded object {id}. */
function idOf(value) {
  if (!value) return null;
  return typeof value === "string" ? value : (value.id ?? null);
}

/**
 * Subscription period end as ISO. The current (basil) API moved
 * `current_period_end` off the Subscription onto its items, so check the item
 * first and fall back to the legacy top-level field for older API versions.
 */
function subPeriodEnd(sub) {
  const item = sub?.items?.data?.[0];
  return toIso(item?.current_period_end ?? sub?.current_period_end ?? null);
}

/** Invoice period end: the line item's period.end, else the top-level period_end. */
function invoicePeriodEnd(invoice) {
  const line = invoice?.lines?.data?.[0];
  return toIso(line?.period?.end ?? invoice?.period_end ?? null);
}

const byCustomer = (id) => ({ column: "stripe_customer_id", value: id });
const byUser = (id) => ({ column: "user_id", value: id });

/**
 * Map a Stripe event to { match, patch } or null (unhandled).
 *   match — { column, value } the row to apply the patch to.
 *   patch — absolute profile-state fields to write (server-write-only columns).
 *
 * @param {{type:string, data:{object:object}}} event  a verified Stripe event
 * @returns {{match:{column:string,value:string|null}, patch:object} | null}
 */
export function applyEvent(event) {
  const type = event?.type;
  const obj = event?.data?.object ?? {};

  switch (type) {
    // The checkout completed — flip to pro and link the customer + subscription.
    // It does NOT authoritatively carry status/period, so those are left to the
    // subscription.* events (omitted here rather than written as null).
    case "checkout.session.completed":
      return {
        match: byUser(obj.client_reference_id ?? null),
        patch: {
          plan: "pro",
          stripe_customer_id: idOf(obj.customer),
          stripe_subscription_id: idOf(obj.subscription),
          subscription_status: "active",
        },
      };

    // The authoritative subscription state: status drives plan, period is fresh.
    case "customer.subscription.created":
    case "customer.subscription.updated":
      return {
        match: byCustomer(idOf(obj.customer)),
        patch: {
          plan: ACTIVE_STATUSES.includes(obj.status) ? "pro" : "free",
          stripe_customer_id: idOf(obj.customer),
          stripe_subscription_id: obj.id ?? null,
          subscription_status: obj.status ?? null,
          current_period_end: subPeriodEnd(obj),
        },
      };

    // Subscription gone — downgrade to free, mark canceled.
    case "customer.subscription.deleted":
      return {
        match: byCustomer(idOf(obj.customer)),
        patch: {
          plan: "free",
          stripe_customer_id: idOf(obj.customer),
          stripe_subscription_id: obj.id ?? null,
          subscription_status: "canceled",
          current_period_end: subPeriodEnd(obj),
        },
      };

    // A recurring payment succeeded — keep pro and refresh the period end.
    case "invoice.paid":
      return {
        match: byCustomer(idOf(obj.customer)),
        patch: {
          plan: "pro",
          stripe_customer_id: idOf(obj.customer),
          stripe_subscription_id: idOf(obj.subscription),
          subscription_status: "active",
          current_period_end: invoicePeriodEnd(obj),
        },
      };

    // A payment failed — flag past_due. Do NOT auto-downgrade here: Stripe's
    // dunning may still recover it; the subscription.deleted event downgrades.
    case "invoice.payment_failed":
      return {
        match: byCustomer(idOf(obj.customer)),
        patch: {
          stripe_customer_id: idOf(obj.customer),
          stripe_subscription_id: idOf(obj.subscription),
          subscription_status: "past_due",
        },
      };

    default:
      return null;
  }
}

export { BILLING_COLUMNS };
