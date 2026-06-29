/**
 * reference/quota.supabase.reference.ts — REFERENCE GLUE, NOT CORE.
 * ──────────────────────────────────────────────────────────────────────────
 * This file is illustrative wiring the CLIENT adapts; it is intentionally NOT
 * imported by the package and NOT covered by selftest.mjs (which stays offline).
 * It shows how to satisfy the core's INJECTED seam — `fetchCount(windowStart)` —
 * against a Supabase table, and how to resolve `isPro` from a profile row.
 *
 * The CORE (src/quota.mjs, src/enforce.mjs) is pure and DB-agnostic. Everything
 * Supabase-specific lives here so the math stays testable without a database.
 *
 * Faithful to Tessera's lib/quota.ts: count rows whose status is "started" in the
 * trailing window, RLS-scoped to the caller; Pro is unlimited ONLY with a live
 * subscription; the dev allow-list takes precedence over both.
 *
 * Generalised: `countedTable` / `startedStatuses` are config, so the same glue
 * meters any countable resource (tasks, exports, runs, API calls), not just tasks.
 */
import type { SupabaseClient, User } from "@supabase/supabase-js";

// In a real app, import from the package:
//   import { getQuota, loadConfig } from "@webapp/usage-quota/quota";
//   import { enforceQuota } from "@webapp/usage-quota/enforce";
import { getQuota, loadConfig } from "../src/quota.mjs";
import { enforceQuota } from "../src/enforce.mjs";

/** Which rows count, and on which columns — config, not code. */
export interface CountedResource {
  table: string; // e.g. "tasks"
  statusColumn: string; // e.g. "status"
  startedStatuses: string[]; // e.g. ["working","review","approved","done"]
  timestampColumn: string; // e.g. "created_at"
  ownerColumn: string; // e.g. "user_id"
}

/** Tessera's metered resource, as an example. */
export const TASKS_RESOURCE: CountedResource = {
  table: "tasks",
  statusColumn: "status",
  startedStatuses: ["working", "review", "approved", "done"],
  timestampColumn: "created_at",
  ownerColumn: "user_id",
};

/**
 * Build the INJECTED counter the core calls. The returned function is what
 * getQuota invokes as `fetchCount(windowStart)`. The RLS-scoped server client
 * means the count only ever sees the caller's own rows.
 */
export function makeFetchCount(
  supabase: SupabaseClient,
  user: User,
  resource: CountedResource = TASKS_RESOURCE,
): (windowStart: string) => Promise<number> {
  return async (windowStart: string): Promise<number> => {
    const { count, error } = await supabase
      .from(resource.table)
      .select("id", { count: "exact", head: true })
      .eq(resource.ownerColumn, user.id)
      .gt(resource.timestampColumn, windowStart)
      .in(resource.statusColumn, resource.startedStatuses);
    if (error) throw error; // surface DB failure; never silently count 0
    return count ?? 0;
  };
}

/**
 * Resolve `isPro` from a profile row. Pro is unlimited ONLY with a live
 * subscription — a stale `plan='pro'` with no active subscription falls back to
 * the free quota (Tessera Phase 5 rule). Read defensively: billing columns may
 * not exist pre-migration, so a missing column is just "not pro".
 */
const ACTIVE_SUBSCRIPTION = ["active", "trialing"];
export async function resolveIsPro(
  supabase: SupabaseClient,
  user: User,
): Promise<boolean> {
  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();
  const plan = typeof (profile as any)?.plan === "string" ? (profile as any).plan : "free";
  const status =
    typeof (profile as any)?.subscription_status === "string"
      ? (profile as any).subscription_status
      : "";
  return plan === "pro" && ACTIVE_SUBSCRIPTION.includes(status);
}

/**
 * Example: the full gate inside a Next.js Server Action — the ACTION BOUNDARY.
 * Mirrors Tessera's startTask(): evaluate, enforce BEFORE the metered side-effect
 * (status flip / n8n trigger / Stripe charge), redirect to /billing?reason=quota
 * on block. Config (limit/window/allow-list) comes from env via loadConfig().
 *
 *   QUOTA_LIMIT=5  QUOTA_WINDOW_DAYS=7  QUOTA_DEV_ALLOWLIST="dev@x.dev, admin@x.dev"
 */
export async function assertCanConsume(
  supabase: SupabaseClient,
  user: User,
  resource: CountedResource = TASKS_RESOURCE,
): Promise<void> {
  const cfg = loadConfig(process.env);
  const isPro = await resolveIsPro(supabase, user);
  const quota = await getQuota({
    fetchCount: makeFetchCount(supabase, user, resource),
    user: { email: user.email ?? null, isPro },
    cfg,
  });

  // enforceQuota throws QuotaExceededError when over. In a Server Action, catch
  // it and call the framework's redirect with quota.redirect — or use the
  // non-throwing quotaSignal(quota) and branch on the returned URL.
  try {
    enforceQuota(quota); // → { redirect: "/billing?reason=quota" } on the error
  } catch (err) {
    if (err && (err as any).name === "QuotaExceededError") {
      // next/navigation redirect((err as QuotaExceededError).redirect)
      redirect((err as any).redirect);
    }
    throw err;
  }
}

// Stand-in so this reference type-checks in isolation; the real app imports
// `redirect` from "next/navigation".
declare function redirect(url: string): never;
