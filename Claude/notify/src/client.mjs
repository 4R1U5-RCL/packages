// packages/notify/src/client.mjs — the OUTBOUND notify seam (shared contract).
//
// Studio-internal infra. A thin, dependency-free function that POSTs a notify
// event to the studio's hosted [STUDIO_NOTIFICATIONS] n8n workflow, which fans it
// out to Telegram. This module is the ONE place the request envelope + signature
// are constructed, so every caller (the Claude Code hook in ../bin/notify.mjs,
// and any in-repo caller) speaks the same contract.
//
// Node 22 built-ins only. No npm deps. (Same discipline as ~/packages/audit.)
//
// AUTH — two gates, one shared secret (deliberately matching the studio's
// established n8n contract: packages/integrations/src/n8n/hooks.ts, TE-16):
//   1. Header Auth `X-Notify-Token: <secret>` — the n8n webhook node's native
//      gate. A wrong/absent token is rejected 401 at the edge, before any node
//      runs (this is the handoff's wrong-token earned-pass).
//   2. HMAC-SHA256 over `${timestamp}.${body}` in `x-notify-signature`, with the
//      unix-ms time in `x-notify-timestamp`. Proves integrity + freshness (≤5min
//      skew), and honours ~/packages/audit/notify/README.md's non-negotiable
//      "sign the payload — do not post unsigned".
//
// Time is ALWAYS injected by the caller (`ts`), never read here — so the request
// builder is pure and unit-testable offline (mirrors audit's "this pkg never
// calls Date.now itself").

import { createHmac } from "node:crypto";

export const NOTIFY_SCHEMA = "studio.notify.v1";
export const TOKEN_HEADER = "X-Notify-Token";
export const SIG_HEADER = "x-notify-signature";
export const TS_HEADER = "x-notify-timestamp";
export const MAX_SKEW_MS = 5 * 60 * 1000;

/** Hex HMAC-SHA256 of `body` under `secret`. The one signing primitive; the n8n
 *  workflow's verify step recomputes exactly this. */
export function sign(body, secret) {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * Build the canonical request for a notify event: the exact body bytes and the
 * headers (token + signature + timestamp). PURE — give it `ts`; it reads no
 * clock and performs no I/O, so a test can assert the signature deterministically.
 *
 * @param {{source:string, kind?:string|null, message?:string, event?:object|null, meta?:object, ts:number}} ev
 * @param {{token:string, secret?:string}} cfg  secret defaults to token (single-secret mode)
 * @returns {{body:string, headers:Record<string,string>, payload:object}}
 */
export function buildRequest(ev, cfg) {
  const timestamp = String(ev.ts);
  const payload = {
    schema: NOTIFY_SCHEMA,
    source: ev.source,                 // 'claude-code' | 'audit' | ...
    kind: ev.kind ?? null,             // 'attention' | 'complete' | 'alert'
    message: ev.message ?? "",         // the title line
    summary: ev.summary ?? null,       // free local body (n8n composes title+summary+footer)
    event: ev.event ?? null,           // optional structured event (e.g. audit.alert.v1)
    meta: ev.meta ?? {},
    sentAt: new Date(ev.ts).toISOString(),
  };
  const body = JSON.stringify(payload);
  const secret = cfg.secret ?? cfg.token;
  return {
    body,
    payload,
    headers: {
      "Content-Type": "application/json",
      [TOKEN_HEADER]: cfg.token,
      [TS_HEADER]: timestamp,
      [SIG_HEADER]: sign(`${timestamp}.${body}`, secret),
    },
  };
}

/**
 * Fire a notify event at the hosted workflow. Fail-SOFT by design: it resolves a
 * result object and never throws on a transport error, so a caller wired into a
 * Claude Code hook can never be blocked by a webhook outage. The distinction the
 * audit contract cares about — delivered vs not — is carried in the result, never
 * swallowed into a silent success.
 *
 * @param {{source:string, kind?:string|null, message?:string, event?:object|null, meta?:object}} ev
 * @param {{url:string, token:string, secret?:string, ts?:number, timeoutMs?:number}} cfg
 * @returns {Promise<{ok:boolean, status:number, delivered:boolean, channel:string|null, note:string}>}
 */
export async function notify(ev, cfg) {
  if (!cfg?.url || !cfg?.token) {
    return {
      ok: false, status: 0, delivered: false, channel: null,
      note: "NOT WIRED — NOTIFY_WEBHOOK_URL / NOTIFY_TOKEN absent. Nothing sent.",
    };
  }
  const ts = cfg.ts ?? Date.now();
  const { body, headers } = buildRequest({ ...ev, ts }, cfg);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 5000);
  try {
    const res = await fetch(cfg.url, { method: "POST", headers, body, signal: ctrl.signal });
    // Respond-Immediately workflow: a 2xx means the webhook ACCEPTED the call. It
    // does NOT by itself prove Telegram delivery — earned-pass polls the n8n
    // execution to confirm the Telegram node actually ran (handoff §3/§7).
    return {
      ok: res.ok, status: res.status, delivered: res.ok,
      channel: res.ok ? "telegram" : null,
      note: res.ok ? "accepted by n8n webhook" : `n8n webhook rejected: HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      ok: false, status: 0, delivered: false, channel: null,
      note: `transport error (not a rejection): ${err?.name === "AbortError" ? "timeout" : err?.message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
