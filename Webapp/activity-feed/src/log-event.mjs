// activity-feed/src/log-event.mjs — the single logEvent() seam.
//
// One place an activity/audit event is shaped and written. PURE core
// (buildEvent) + a thin impure boundary (logEvent) that takes an INJECTED
// insert fn — so the whole seam is unit-testable offline with no Supabase, no
// network, no env. Node-22 built-ins only; zero dependencies.
//
// THE SEAM (read this before scattering inserts again): server actions today
// write activity inline — each action hand-rolls "what happened" and how it
// lands in the DB. That drifts: the same lifecycle event gets two shapes in two
// actions, a level is a free string in one and absent in another. This module is
// the one funnel: an action calls logEvent({insert}, {userId, type, level,
// message, meta}) and nothing else decides the row shape or the validation.
//
//   buildEvent(...)  PURE — caller injects ts; validates; returns the DB row.
//   logEvent(...)    awaits an injected insert(row); the only impure part, and
//                    the inject point is what makes it testable.

/** Allowed severities. An activity row's `level` MUST be one of these. */
export const LEVELS = Object.freeze(["info", "success", "warning", "error"]);

/**
 * Allowed event types — the FIXED lifecycle vocabulary. New surfaces add a
 * member here (everyone gets it), they do not invent an ad-hoc string at the
 * call site. Keeping this closed is what lets the feed filter/group reliably and
 * stops the inline-drift this seam exists to kill.
 */
export const TYPES = Object.freeze([
  "task.submitted", // a new task/request was submitted by the user
  "task.amended",   // an existing task was revised / change-requested
  "task.approved",  // a task/result was approved at the human gate
  "task.rejected",  // a task/result was sent back / declined
  "task.emailed",   // a report/result was emailed out
  "auth.signed_in", // session lifecycle (kept generic, not commerce state)
  "system.note",    // catch-all operational note (still typed + leveled)
]);

/** A typed error so callers can distinguish bad-input from insert failures. */
export class ActivityEventError extends Error {
  constructor(message) {
    super(message);
    this.name = "ActivityEventError";
  }
}

const isNonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;
const isPlainObject = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Shape + validate a single activity event into the row the DB expects. PURE:
 * no clock, no I/O — the caller injects `ts` (epoch ms), so the same inputs
 * always yield the same row and the function is trivially testable.
 *
 * Validates: userId/type/level/message present and well-formed, level ∈ LEVELS,
 * type ∈ TYPES, meta (optional) a plain JSON object, ts a finite number. Throws
 * ActivityEventError on any violation — a bad event never silently becomes a row.
 *
 * @param {object} e
 * @param {string} e.userId  owner of the event (maps to user_id; RLS scopes reads to this)
 * @param {string} e.type    one of TYPES
 * @param {string} e.level   one of LEVELS
 * @param {string} e.message human-readable summary
 * @param {object} [e.meta]  optional structured detail (jsonb)
 * @param {number} e.ts      epoch milliseconds, INJECTED by the caller
 * @returns {{user_id:string,type:string,level:string,message:string,meta:object,ts:string}}
 */
export function buildEvent({ userId, type, level, message, meta = {}, ts } = {}) {
  if (!isNonEmptyString(userId)) {
    throw new ActivityEventError("userId is required (non-empty string)");
  }
  if (!isNonEmptyString(type) || !TYPES.includes(type)) {
    throw new ActivityEventError(
      `type must be one of ${TYPES.join(", ")} (got ${JSON.stringify(type)})`,
    );
  }
  if (!isNonEmptyString(level) || !LEVELS.includes(level)) {
    throw new ActivityEventError(
      `level must be one of ${LEVELS.join(", ")} (got ${JSON.stringify(level)})`,
    );
  }
  if (!isNonEmptyString(message)) {
    throw new ActivityEventError("message is required (non-empty string)");
  }
  if (!isPlainObject(meta)) {
    throw new ActivityEventError("meta must be a plain object when provided");
  }
  if (typeof ts !== "number" || !Number.isFinite(ts)) {
    throw new ActivityEventError("ts is required (finite epoch-ms number, caller-injected)");
  }

  return {
    user_id: userId.trim(),
    type,
    level,
    message: message.trim(),
    meta,
    // input ts is epoch-ms (injected); the row's `ts` column is timestamptz, so
    // we hand the DB an ISO string. Matches Tessera's existing `ts` column name.
    ts: new Date(ts).toISOString(),
  };
}

/**
 * Write one activity event through an INJECTED insert function.
 *
 * The insert fn is the whole point: in production it is a server-only (service-
 * role) Supabase insert; in tests it is a spy. logEvent never imports Supabase,
 * so the seam is exercised offline. The only impurity is the default clock —
 * pass `ts` to keep a call fully deterministic.
 *
 * @param {{insert:(row:object)=>any}} deps  insert(row) → result|Promise (service-role write)
 * @param {object} event  same shape as buildEvent's argument; `ts` optional (defaults to now)
 * @returns {Promise<{ok:boolean, row:object, result:any}>}
 */
export async function logEvent({ insert } = {}, event = {}) {
  if (typeof insert !== "function") {
    throw new ActivityEventError("logEvent requires an injected insert(row) function");
  }
  const ts = typeof event.ts === "number" ? event.ts : Date.now();
  const row = buildEvent({ ...event, ts });
  const result = await insert(row);
  return { ok: true, row, result };
}
