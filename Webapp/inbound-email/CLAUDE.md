# inbound-email — Hard Constraints

> Domain CLAUDE.md. Canonical for this feature-package. The generator reads this
> before touching anything here.

## What this package is

The FIXED inbound-email forwarder: signed Resend inbound webhook → verify →
fetch → forward to a configured mailbox with `reply_to` = the original sender.
Configured per client via env, never rebuilt. The CORE (`verify`, `forward`) is
dependency-free and offline-testable; the route is REFERENCE the client wires in.

## HARD constraints

- **Verify over the RAW body, never the parsed JSON.** `verify.mjs` runs HMAC over
  the exact bytes received. Parsing before verifying is a signature-bypass bug —
  the route reads `await req.text()` and only `JSON.parse`es *after* a pass.
- **Constant-time compare + ±5-min replay window are non-negotiable.** A naive
  `===` or a missing freshness check is a HARD finding. Matches the studio's n8n
  HMAC + 5-min replay contract (TE-16) and the `audit` package's `webhook-auth`
  discipline (sign, reject stale).
- **Two keys, least privilege.** The **send** path uses a **send-only-scoped** key
  (`RESEND_API_KEY`). Only the **fetch** (`receiving:read`) and **domain ops**
  (`provision-dns`) need the **full-access** key (`RESEND_FULL_ACCESS_API_KEY`).
  Do not use the full-access key for sending; do not give the send key domain scope.
- **No secrets in any file.** Secrets come from env or the chmod-600
  `~/.claude/inbound-email.env` fallback. A `whsec_`/`re_` value committed here is
  a boundary finding. Fixtures use obviously-fake local bytes only.
- **The route MUST be public.** `/api/inbound` belongs in the middleware
  `PUBLIC_PATHS`, or the auth middleware 307-redirects Resend's unauthenticated
  POST to `/sign-in` and forwarding silently dies (a recorded ERRORS finding). The
  route's own Svix verification is what keeps a public route safe.
- **No SDK vendored.** `resend.mjs` is thin `fetch` against `api.resend.com`. Node
  22 built-ins only across the CORE.

## What the evaluator checks here

- Signature verified over raw body, constant-time, with a ±5-min replay window.
- Send key is send-scoped; full-access key only on fetch + domain ops.
- No secret literal (`whsec_`, `re_`, API keys) anywhere in the package.
- `/api/inbound` documented as a required `PUBLIC_PATHS` entry.
- `selftest.mjs` exits non-zero when any assertion fails (a pass is EARNED).

## Boundary — the recurring services' IP never enters this package (baseline §8)

This package is the signed seam only: the route, the verifier, the thin Resend
client, and doc snippets. **n8n workflow DEFINITIONS never enter here** — if a
client wants inbound mail to drive a hosted workflow, the workflow lives on the
studio's hosted n8n instance and is called via a hook, exactly as
`packages/integrations` mandates. A workflow definition (or a scraping/pipeline
body) appearing in this package is a reverse-gate B violation, not a build to retry.

## What stays human (back gate)

The one-time **DNS publish** (registrar MX → `inbound-smtp.<region>.amazonaws.com`
+ SPF/DKIM/DMARC) is human-gated: `provision-dns.mjs` ensures the Resend side and
prints the exact records, but a human adds them at the registrar. "Did the right
mail reach the right inbox" is a human read at the back gate, not a machine verdict.
