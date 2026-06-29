// reference/usage.reference.ts — how a server action calls the logEvent() seam.
//
// REFERENCE, not wired. `.reference.ts` so it is never compiled into a client
// build; it shows the call sites a host app adopts. The .mjs core is the only
// runtime code in this package — this file demonstrates the seam in a Tessera-
// shaped Next.js server action.
//
// THE SHIFT (see README): today Tessera writes activity INLINE inside each
// action, with the SAME RLS-scoped anon client that serves the user:
//
//     // before — inline, in app/(app)/actions.ts
//     await supabase.from('activity_events').insert({
//       task_id: id, user_id: user.id, level: 'info', message: 'Submitted',
//     });
//
// That couples every action to the row shape and lets the browser-trusted role
// write the audit trail. The seam below replaces each such block with one
// logEvent() call against a SERVER-ONLY (service-role) insert, so the row shape
// + validation live in one place and the client can never forge a row.

import { logEvent } from "../src/log-event.mjs";

// ── Wiring the injected insert ONCE (e.g. lib/activity.ts) ───────────────────
//
// The service-role client bypasses RLS — it is the only writer of this table.
// It is created server-side from env and NEVER shipped to the browser. The
// insert fn is the seam's single injection point.

// import { createServiceClient } from "@/lib/supabase"; // service-role, server-only
type Row = Record<string, unknown>;

/** App-level binding: a service-role insert into activity_events. */
export function activityInsert() {
  // const supabase = createServiceClient(); // SUPABASE_SERVICE_ROLE_KEY, server only
  return async (row: Row) => {
    // const { error } = await supabase.from("activity_events").insert(row);
    // if (error) throw error;
    return row; // reference stub
  };
}

/** One narrow helper the actions call, so the insert binding lives in one spot. */
export async function recordActivity(event: {
  userId: string;
  type: string;
  level: string;
  message: string;
  meta?: Record<string, unknown>;
}) {
  // ts is omitted → logEvent stamps it (server clock). Pass ts to make it
  // deterministic (e.g. in tests).
  return logEvent({ insert: activityInsert() }, event);
}

// ── Call sites, one per Tessera lifecycle action ─────────────────────────────
// These mirror the 6 inline events the explorer found in actions.ts /
// extra-actions.ts. `task_id` rides in `meta` instead of a bespoke column.

export async function onTaskSubmitted(userId: string, taskId: string) {
  await recordActivity({
    userId, type: "task.submitted", level: "info",
    message: "Submitted", meta: { taskId },
  });
}

export async function onTaskApproved(userId: string, taskId: string) {
  await recordActivity({
    userId, type: "task.approved", level: "success",
    message: "Approved output", meta: { taskId },
  });
}

export async function onTaskAmended(userId: string, taskId: string, summary: string) {
  await recordActivity({
    userId, type: "task.amended", level: "info",
    message: `Amend requested — ${summary}`, meta: { taskId, summary },
  });
}

export async function onTaskResubmitted(userId: string, taskId: string) {
  await recordActivity({
    userId, type: "task.submitted", level: "info",
    message: "Resubmitted", meta: { taskId, retry: true },
  });
}

export async function onReportEmailed(userId: string, taskId: string, recipient: string) {
  await recordActivity({
    userId, type: "task.emailed", level: "success",
    message: `Emailed report to ${recipient}`, meta: { taskId, recipient },
  });
}

// A failure surfaces as a leveled event — the severity the inline `level: 'info'`
// could never express, now that level is a validated enum.
export async function onEmailFailed(userId: string, taskId: string, reason: string) {
  await recordActivity({
    userId, type: "system.note", level: "error",
    message: "Failed to email report", meta: { taskId, reason },
  });
}
