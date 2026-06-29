// notify/notify.mjs — THE ALERT-DISPATCH SEAM (currently a STUB).
//
// This is the single interface through which the audit package dispatches an
// alert. Right now it is DELIBERATELY NOT WIRED: an n8n workflow will be built
// to receive and route alerts, and will drop in behind this seam later. Until
// then, send_alert() must make it IMPOSSIBLE to mistake "not wired" for
// "delivered" — a stub that quietly returns success is the exact false-pass this
// whole package exists to forbid (WORKING_METHOD §7).
//
// THE CONTRACT (do not change without updating notify/README.md and the n8n side):
//
//   send_alert(event) -> {
//     delivered: boolean,        // did the event actually reach a channel?
//     status: "delivered" | "not-wired" | "error",
//     channel: string | null,    // which channel delivered it (null when not-wired)
//     note: string,              // human-readable, loud about stub state
//     event,                     // the event echoed back
//   }
//
// The stub returns delivered:false, status:"not-wired" — a DISTINCT not-wired
// status, never a silent success. Callers (e.g. checks/alert-route.mjs) MUST
// treat anything other than delivered:true as NOT delivered.
//
// Node 22 built-ins only. No npm deps. Self-contained inside the audit package.

import { createHmac } from "node:crypto";

export const NOT_WIRED = "not-wired";
export const DELIVERED = "delivered";
export const ERROR = "error";

// The expected event payload shape — the fixed contract the n8n side builds
// against (mirrored in notify/README.md). Kept here so the shape lives once.
export function makeEvent({ source, severity, control, title, detail, ts = null }) {
  return {
    schema: "audit.alert.v1",
    source: source ?? "audit",        // which layer raised it (skill/ci/scheduled)
    severity: severity ?? "info",     // info | warning | critical
    control: control ?? null,         // the control that fired, if any
    title: title ?? "",
    detail: detail ?? "",
    ts,                               // caller-stamped ISO time (this pkg never calls Date.now itself)
  };
}

// The seam. When the n8n workflow exists, the BODY of this function is replaced
// with an authenticated, signed POST to the n8n webhook (HMAC-SHA256, per the
// webhook-auth boundary — do not undermine your own check by posting unsigned),
// and NOTHING upstream changes: same signature, same return shape.
export async function send_alert(event) {
  const url = process.env.NOTIFY_WEBHOOK_URL;
  const token = process.env.NOTIFY_TOKEN;
  const secret = process.env.NOTIFY_SECRET || token;

  // UNCONFIGURED → still the honest not-wired status, never a silent success.
  if (!url || !token) {
    process.stderr.write(
      `STUB: alert NOT delivered — NOTIFY_WEBHOOK_URL/NOTIFY_TOKEN unset. ` +
      `Event: ${JSON.stringify(event)}\n`);
    return {
      delivered: false, status: NOT_WIRED, channel: null,
      note: "NOT WIRED — set NOTIFY_WEBHOOK_URL + NOTIFY_TOKEN to deliver via the " +
            "hosted [STUDIO_NOTIFICATIONS] n8n workflow. See notify/README.md.",
      event,
    };
  }

  // Transport envelope. ts is SEND-TIME (the replay-guard clock) — distinct from
  // the event's caller-stamped semantic time; signing a fresh request needs it.
  // The shape + key order mirror @studio/notify's client exactly, so the n8n
  // workflow's HMAC check (which re-stringifies the parsed body) verifies. The
  // audit event rides in `event`; the workflow routes audit.alert.v1 → 🔴 format.
  const ts = Date.now();
  const payload = {
    schema: "studio.notify.v1",
    source: "audit",
    kind: "alert",
    message: "",
    summary: null,
    event,
    meta: {},
    sentAt: new Date(ts).toISOString(),
  };
  const body = JSON.stringify(payload);
  const signature = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Notify-Token": token,
          "x-notify-timestamp": String(ts),
          "x-notify-signature": signature,
        },
        body,
        signal: ctrl.signal,
      });
    } finally { clearTimeout(timer); }

    if (res.ok) {
      return { delivered: true, status: DELIVERED, channel: "telegram",
        note: `delivered via [STUDIO_NOTIFICATIONS] n8n (HTTP ${res.status})`, event };
    }
    // A WIRED channel that refused is a real finding (alert-route → fail).
    return { delivered: false, status: ERROR, channel: null,
      note: `wired channel did NOT deliver: HTTP ${res.status}`, event };
  } catch (err) {
    return { delivered: false, status: ERROR, channel: null,
      note: `wired channel error: ${err?.name === "AbortError" ? "timeout" : err?.message}`, event };
  }
}

// CLI: `node notify/notify.mjs --title "..." --detail "..."` — fire one event
// through the seam and print the result, so the stub state is observable by hand.
import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const get = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
  const ev = makeEvent({
    source: get("source", "cli"),
    severity: get("severity", "info"),
    control: get("control", null),
    title: get("title", "manual test event"),
    detail: get("detail", "fired from notify.mjs CLI"),
  });
  const res = await send_alert(ev);
  process.stdout.write(JSON.stringify(res) + "\n");
  // Exit 2 (the package's "could not verify / not-green" code) so a wrapper that
  // shells out cannot read a 0 as "delivered".
  process.exit(res.delivered ? 0 : 2);
}
