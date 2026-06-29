// src/forward.mjs — pure forward-payload logic (CORE, no network, no SDK).
//
// Given a fetched inbound message + the configured forward identity, build the
// exact POST /emails body that forwards it: a "forwarded-from" banner injected
// ahead of the original content, the recipient allow-list decision, and
// reply_to set to the ORIGINAL sender so a reply goes back to the real person,
// not to info@. Every function here is pure and offline-testable.

/** Minimal HTML escaping for the banner / text fallback (no markup injection). */
export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Lower-cased bare addresses pulled out of a `Name <a@b>` or `a@b` list. */
export function bareAddrs(values) {
  return (values ?? []).map((v) => {
    const m = String(v).match(/<([^>]+)>/);
    return (m ? m[1] : v).trim().toLowerCase();
  });
}

/** Parse the comma-separated INBOUND_FORWARD_ONLY env into a lowercased list. */
export function parseAllowList(raw) {
  return String(raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Allow-list decision over a delivery's recipients.
 *   - empty allow-list           → forward everything (allow-list disabled).
 *   - recipients unknown (empty)  → forward (can't prove it's off-list).
 *   - otherwise                   → forward only if a recipient is on the list.
 * This keeps a root-domain MX from fanning every address on the domain into the
 * personal inbox while never silently dropping mail we can't classify.
 */
export function recipientAllowed(recipients, allowList) {
  if (!allowList.length) return true;
  if (!recipients.length) return true;
  return recipients.some((r) => allowList.includes(r));
}

/** The grey "Forwarded from <sender> to <recipients>" banner (HTML). */
export function buildBanner(mail) {
  const to = mail.to?.length ? ` to ${escapeHtml(mail.to.join(", "))}` : "";
  return (
    `<p style="color:#888;font-size:12px;border-bottom:1px solid #eee;padding-bottom:8px">` +
    `Forwarded from <b>${escapeHtml(mail.from)}</b>${to}</p>`
  );
}

/** Resend inbound stores attachments out-of-band; note them rather than inline. */
export function attachmentNote(mail) {
  const a = mail.attachments ?? [];
  if (a.length === 0) return "";
  return (
    `\n\n[${a.length} attachment(s) not inlined: ` +
    a.map((x) => x.filename).join(", ") +
    `. View them in the Resend dashboard.]`
  );
}

/**
 * Build the POST /emails body that forwards `mail`.
 *
 * @param {{from:string, to?:string[], subject?:string|null, html?:string|null,
 *          text?:string|null, attachments?:{filename:string}[]}} mail  fetched message
 * @param {{from:string, to:string}} cfg  verified sending identity + forward target
 * @returns {object} the JSON-serialisable Resend send payload
 */
export function buildForwardPayload(mail, cfg) {
  const banner = buildBanner(mail);
  const note = attachmentNote(mail);
  const html = mail.html
    ? banner + mail.html
    : banner + `<pre>${escapeHtml((mail.text ?? "") + note)}</pre>`;
  const text = (mail.text ?? "") + note || undefined;
  return {
    from: cfg.from,
    to: [cfg.to],
    reply_to: mail.from, // replies reach the original sender, not info@
    subject: mail.subject || "(no subject)",
    html,
    text,
  };
}
