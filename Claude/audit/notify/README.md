# notify/ — the alert-dispatch seam (currently a STUB)

This directory is the **single seam** through which the audit package dispatches
an alert. It exists so the rest of the package can be built and verified now,
with one clearly-declared, unwired interface awaiting the n8n side.

> **Current state: WIRED.** `send_alert()` POSTs an HMAC-signed event to the
> studio's hosted `[STUDIO_NOTIFICATIONS]` n8n workflow (Telegram). With
> `NOTIFY_WEBHOOK_URL` + `NOTIFY_TOKEN` set it delivers and returns
> `delivered:true` / `status:"delivered"` / `channel:"telegram"`; the
> `alert-route` check then reports **`pass`** (verified live — a real 🔴 test
> event was watched to arrive). When those env vars are ABSENT it still returns
> the honest `not-wired` status (never a silent success), so `alert-route`
> reports `unknown` rather than a false pass — e.g. a CI/scheduled run without the
> secret. A wired channel that fails to deliver returns `status:"error"` → the
> check reports `fail`.

## The contract (`send_alert(event)`)

`notify.mjs` exports one async function:

```js
import { send_alert, makeEvent } from "./notify/notify.mjs";

const res = await send_alert(makeEvent({
  source:   "scheduled",     // skill | ci | scheduled — which layer raised it
  severity: "critical",      // info | warning | critical
  control:  "webhook-auth",  // the control that fired, if any
  title:    "infra control regressed",
  detail:   "webhook-auth returned fail on the live n8n endpoint",
  ts:       new Date().toISOString(),  // the CALLER stamps time; this pkg never calls Date.now itself
}));
// res => { delivered, status, channel, note, event }
```

**Return shape — the fixed contract:**

| field | type | meaning |
|-------|------|---------|
| `delivered` | boolean | did the event actually reach a channel? **Stub: always `false`.** |
| `status` | `"delivered" \| "not-wired" \| "error"` | **Stub: always `"not-wired"`.** |
| `channel` | string \| null | which channel delivered it (`null` when not-wired) |
| `note` | string | human-readable, loud about the stub state |
| `event` | object | the event echoed back |

Callers MUST treat anything other than `delivered: true` as **not delivered**.

## The event payload shape (`audit.alert.v1`)

This is the fixed contract the **n8n side builds against**. `makeEvent()` is the
one place it is constructed:

```json
{
  "schema":   "audit.alert.v1",
  "source":   "scheduled",
  "severity": "critical",
  "control":  "webhook-auth",
  "title":    "infra control regressed",
  "detail":   "webhook-auth returned fail on the live n8n endpoint",
  "ts":       "2026-06-28T12:00:00.000Z"
}
```

## Wiring n8n in later (the drop-in)

When the n8n workflow exists, replace **only the body** of `send_alert()` in
`notify.mjs` with an authenticated POST to the n8n webhook. Nothing upstream
changes — same signature, same return shape. Two non-negotiables:

1. **Sign the payload** (HMAC-SHA256), exactly as the package's own
   `webhook-auth` check requires of inbound webhooks. Do not undermine your own
   boundary by posting an unsigned alert.
2. **Recurring boundary (baseline §8).** The n8n workflow that sits behind this
   seam is **your hosted infrastructure**, not client-delivered code — the same
   as every other n8n use. The stub and this contract live in `audit/`; the
   workflow definition itself never enters a client repo.

Once wired, point `alert-route`'s live config at the real route and watch a test
event arrive before letting the check report `pass`.
