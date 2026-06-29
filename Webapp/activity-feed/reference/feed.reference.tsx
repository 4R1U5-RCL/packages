// reference/feed.reference.tsx — a read-only per-user activity feed.
//
// REFERENCE, not wired (`.reference.tsx`, never compiled into a client build).
// It shows how the host renders the trail this package captures. The render is
// deliberately a reference, not a fixed library component: brand styling lives
// in the host's token-driven UI (packages/ui), so this uses plain class names a
// host swaps for its own.
//
// SECURITY NOTE — the read path is RLS, not app logic. This component fetches
// with the user's RLS-scoped client and gets ONLY that user's rows because the
// `activity_events_select_own` policy (auth.uid() = user_id) enforces it in the
// database. The component never filters by user_id itself; it cannot see another
// user's events even if it tried. Reads are owner-scoped at the row level.

import * as React from "react";

export type ActivityRow = {
  id: string;
  ts: string;        // ISO timestamptz
  level: "info" | "success" | "warning" | "error";
  type: string;
  message: string;
  meta: Record<string, unknown>;
};

const LEVEL_GLYPH: Record<ActivityRow["level"], string> = {
  info: "•",
  success: "✓",
  warning: "!",
  error: "✕",
};

function formatTs(iso: string): string {
  // Host can localize; this keeps it dependency-free.
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/**
 * Server-component data load. RLS scopes the result to the current user, so
 * there is no `.eq('user_id', ...)` — the policy already did it.
 *
 *   const supabase = await createServerClient();
 *   const { data } = await supabase
 *     .from("activity_events")
 *     .select("id, ts, level, type, message, meta")
 *     .order("ts", { ascending: false })
 *     .limit(limit);
 */
export async function loadActivity(
  supabase: { from: (t: string) => any },
  limit = 50,
): Promise<ActivityRow[]> {
  const { data, error } = await supabase
    .from("activity_events")
    .select("id, ts, level, type, message, meta")
    .order("ts", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as ActivityRow[];
}

export function ActivityFeed({ events }: { events: ActivityRow[] }) {
  if (!events.length) {
    return <p className="activity-empty">No activity yet.</p>;
  }
  return (
    <ol className="activity-feed" aria-label="Activity">
      {events.map((e) => (
        <li key={e.id} className={`activity-item activity-${e.level}`}>
          <span className="activity-glyph" aria-hidden="true">
            {LEVEL_GLYPH[e.level] ?? "•"}
          </span>
          <span className="activity-message">{e.message}</span>
          <time className="activity-ts" dateTime={e.ts}>
            {formatTs(e.ts)}
          </time>
          <span className="activity-type">{e.type}</span>
        </li>
      ))}
    </ol>
  );
}

/** Reference page wiring: load (RLS-scoped) then render. */
export default async function ActivityFeedSection({
  supabase,
}: {
  supabase: { from: (t: string) => any };
}) {
  const events = await loadActivity(supabase);
  return (
    <section>
      <h2>Recent activity</h2>
      <ActivityFeed events={events} />
    </section>
  );
}
