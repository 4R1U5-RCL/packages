# activity-feed

A structured per-user **in-app audit trail**: an `activity_events` table (owner-read
RLS, **server-only insert**) written from server actions through a single
`logEvent()` seam, plus a reference feed render.

> **NEW SEAM — speculative extraction.** In Tessera the activity writes are
> *inline* across server actions (each hand-rolls "what happened" and how it
> lands). This package is the one funnel that kills that drift — so adopting it is
> a small **refactor** (route existing writes through `logEvent`), not a
> lift-and-shift. Worth it the moment a second surface logs the same lifecycle.

```
src/log-event.mjs                 buildEvent() (pure) + logEvent({insert}, event) seam
migrations/0001_activity_events.sql   table + owner-read RLS + server-only insert + REVOKE
reference/usage.reference.ts      example logEvent() calls from server actions
reference/feed.reference.tsx      read-only feed component
selftest.mjs                      offline earned checks (shape + validation + migration locks)
```

## The seam

```js
import { logEvent, buildEvent } from "./src/log-event.mjs";

// in a server action, after the work succeeds:
await logEvent(
  { insert: (row) => supabase.from("activity_events").insert(row) },
  { userId: user.id, type: "task.submitted", level: "info", message: "Task #42 submitted", meta: { taskId: 42 } },
);
```

- **`buildEvent({userId,type,level,message,meta}, {at})`** — PURE: caller injects
  `at`; validates `type` ∈ `TYPES` and `level` ∈ `LEVELS`; returns the DB row.
  Offline-testable, no clock/DB/network.
- **`logEvent({insert}, event)`** — awaits the INJECTED `insert(row)`; the only
  impure part, and the inject point that makes the seam testable.
- **Closed vocabularies.** `TYPES` (e.g. `task.submitted/amended/approved/…`) and
  `LEVELS` (`info|success|warning|error`) are fixed — a new surface adds a member
  (everyone gets it), it does not invent an ad-hoc string at the call site. That
  closure is what lets the feed filter/group reliably.

## Data model

`activity_events` is **app data Shopify does not own** (baseline §8.1) — tier-gated,
fine to store. RLS: a user reads only their own rows; **only the service role
inserts** (a user can't forge their own audit trail). See the migration; the
selftest asserts the owner-scoped RLS + server-only insert are present.

## Boundary

App-side only — no n8n, no external service. The trail is written by the app's own
server actions through this seam.
