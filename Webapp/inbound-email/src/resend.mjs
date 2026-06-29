// src/resend.mjs — thin Resend receive+send client (fetch, no SDK vendored).
//
// Two calls, nothing else: fetch the full inbound message the webhook only
// referenced, and send the forwarded copy. The webhook payload carries metadata
// only (an email_id), so the body MUST be fetched before it can be forwarded.
//
// `fetchImpl` is injectable purely so these can be exercised against a stub in a
// test; in production the global Node-22 `fetch` is used. No ret/transform logic
// lives here — payload shaping is forward.mjs, signature checking is verify.mjs.

export const RESEND_API = "https://api.resend.com";

/**
 * GET /emails/receiving/{id} — the full inbound message (from/to/subject/html/
 * text/attachments). Needs an API key with `receiving:read`.
 *
 * @param {string} id  the inbound email id from the webhook (`data.email_id`)
 * @param {string} apiKey  RESEND_FULL_ACCESS_API_KEY (receiving:read scope)
 * @param {{fetchImpl?:typeof fetch, api?:string}} [opts]
 * @returns {Promise<object>} the received-email record
 * @throws if the request is not ok (let the route return 502 → Resend retries)
 */
export async function fetchReceivedEmail(id, apiKey, opts = {}) {
  const f = opts.fetchImpl ?? fetch;
  const api = opts.api ?? RESEND_API;
  const res = await f(`${api}/emails/receiving/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`resend receiving GET ${id} → ${res.status}`);
  }
  return res.json();
}

/**
 * POST /emails — send the forwarded copy. `payload` is built by
 * forward.buildForwardPayload(). Needs an API key with `sending` scope (the
 * send-only key is enough here; only domain ops need the full-access key).
 *
 * @param {object} payload  the Resend send body (from/to/reply_to/subject/html/text)
 * @param {string} apiKey  send-scoped key
 * @param {{fetchImpl?:typeof fetch, api?:string}} [opts]
 * @returns {Promise<object>} the send result ({ id })
 * @throws if the request is not ok
 */
export async function sendEmail(payload, apiKey, opts = {}) {
  const f = opts.fetchImpl ?? fetch;
  const api = opts.api ?? RESEND_API;
  const res = await f(`${api}/emails`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`resend send POST → ${res.status}`);
  }
  return res.json();
}
