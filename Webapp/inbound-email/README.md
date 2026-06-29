# inbound-email — signed Resend inbound → forward-to-mailbox

A self-contained, reusable feature-package. Mail to `info@<domain>` lands at a
Resend **inbound** webhook; this package **verifies** the Svix signature over the
raw body, **fetches** the full message, and **forwards** it to a configured
mailbox with the original sender as `reply_to` — so the owner just reads and
replies from their normal inbox.

Resend inbound is **webhook-only**: it cannot forward to an external mailbox by
itself. This package *is* that forwarder. The CORE (verify / forward / client) is
dependency-free Node-22 built-ins and offline-testable; the Next.js route is
clearly-marked REFERENCE the client wires in.

```
src/
  verify.mjs    CORE — Svix/HMAC raw-body verifier (constant-time, ±5-min replay)
  forward.mjs   CORE — pure payload build: banner, allow-list, reply_to=sender
  resend.mjs    thin Resend receive+send client (fetch; no SDK vendored)
route.reference.ts   REFERENCE Next.js route (verify→fetch→forward) the client copies in
scripts/
  provision-dns.mjs  ensure+verify the Resend domain, print the inbound MX + auth records (idempotent)
selftest.mjs    OFFLINE earned checks (accept/reject/replay + banner/allow-list) — exits non-zero on failure
```

## The flow

1. Resend receives mail for the domain (root **MX → `inbound-smtp.us-east-1.amazonaws.com`**)
   and POSTs an `email.received` webhook at `/api/inbound`.
2. The route verifies the **Svix signature over the RAW body** (`RESEND_WEBHOOK_SECRET`).
   Constant-time; deliveries outside a ±5-minute window are rejected (replay guard).
3. The webhook carries metadata only → fetch the full message via
   `GET /emails/receiving/{id}`.
4. Re-send via `POST /emails` from `INBOUND_FORWARD_FROM` to `INBOUND_FORWARD_TO`,
   with `reply_to` set to the **original sender** so replies work, a "forwarded
   from" banner injected, and an optional recipient allow-list.

## Config (env, or `~/.claude/inbound-email.env` fallback)

| Var | Used by | Purpose |
|-----|---------|---------|
| `RESEND_WEBHOOK_SECRET` | route | `whsec_...` endpoint secret; signature verification. |
| `RESEND_API_KEY` | route (send) | **Send-only-scoped** key for `POST /emails`. |
| `RESEND_FULL_ACCESS_API_KEY` | route (fetch) + provision-dns | `receiving:read` + domain ops. |
| `INBOUND_FORWARD_TO` | route | Mailbox forwarded mail lands in. |
| `INBOUND_FORWARD_FROM` | route | Verified sending identity, e.g. `Inbox <info@shop.dev>`. |
| `INBOUND_FORWARD_ONLY` | route | Comma-separated recipient allow-list (e.g. `info@shop.dev`). |
| `INBOUND_DOMAIN` / `INBOUND_REGION` | provision-dns | Domain to provision; region (default `us-east-1`). |

**No secrets live in any file in this package.** Set them in the host env (Vercel
project env) or the chmod-600 fallback file.

## One-time human setup (DNS — cannot be fully automated)

DNS lives at the registrar and gates inbound + deliverability. Run the script to
get the exact records, then publish them once:

```bash
RESEND_FULL_ACCESS_API_KEY=... node scripts/provision-dns.mjs --domain shop.dev
```

It ensures the domain exists in Resend (idempotent), triggers verification, and
prints the records to add at the registrar:

- **`MX  @  inbound-smtp.us-east-1.amazonaws.com  priority 10`** — routes inbound mail to Resend.
- **SPF / DKIM / DMARC** (the TXT/CNAME records Resend returns) — required for the
  *outbound* forward to authenticate and not land in spam.

Re-run until it reports `status: verified`. Then register the webhook in Resend
pointing at `https://<domain>/api/inbound` for the `email.received` event.

## Wire the route (client app)

Copy `route.reference.ts` → `app/api/inbound/route.ts` and point its imports at
the installed package.

> ⚠️ **Add `/api/inbound` to the middleware `PUBLIC_PATHS`.** Resend POSTs
> unauthenticated; if the route sits behind the auth wall, middleware
> **307-redirects** the POST to `/sign-in` and Resend never reaches the handler —
> inbound mail silently never forwards. (This is a recorded ERRORS finding.) The
> route does its own Svix verification, so making it public is safe. Confirm:
> `curl -i https://<domain>/api/inbound` returns **400** (bad signature), not
> **307**.

## Prove it (offline, before any live wiring)

```bash
node selftest.mjs   # 10 earned checks; exits non-zero if any fails
```

## Boundary

INBOUND receive-and-forward only. The recurring services' IP stays out: no n8n
workflow **definitions** enter this package — only the signed route, the verifier,
the thin Resend client, and doc snippets. See `CLAUDE.md`.
