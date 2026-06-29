# Webapp — reusable web-app feature-packages

Standalone, reusable web-app features extracted from the **Tessera** project, in the
same house style as [`../Claude/`](../Claude/): self-contained, env-driven config
(`~/.claude/<pkg>.env` fallback), Node-22 built-ins for the core, an offline
`selftest.mjs` that EARNS its pass (negative controls fire), and a `README.md` +
boundary `CLAUDE.md`. **Recurring boundary throughout:** n8n workflow *definitions*
stay hosted on `csco.app.n8n.cloud`; a package ships only the signed hook/route, a
display/read view, DB migrations, and a doc of the matching n8n node — never the
workflow graph, scrapers, schedulers, or structuring logic.

## Packages

| Package | What it is |
|---------|------------|
| [`n8n-trigger/`](n8n-trigger/) | **Foundational** signed-webhook seam: server-only client that fires a hosted n8n workflow with a timestamped HMAC + the matching inbound verifier (TE-16). The pattern the other n8n features reuse. |
| [`inbound-email/`](inbound-email/) | Inbound mail → forward. Resend inbound webhook → Svix raw-body HMAC verify (±5-min replay) → fetch full message → forward with `reply_to`=sender. Idempotent DNS provision; the route must be a `PUBLIC_PATHS` entry. |
| [`transactional-email/`](transactional-email/) | `sendEmail(to,subject,html,attachment?)` via the Resend REST API with recipient validation + fail-soft no-op. Backs the in-app "email the report" action and the hosted email-on-done node. |
| [`usage-quota/`](usage-quota/) | Rolling-window usage limiter over any countable resource (e.g. 5 started / 7 days), with Pro + dev-allow-list exemptions; enforces at the action boundary (`/billing?reason=quota`). Pure math + injected counter. |
| [`scheduled-runs/`](scheduled-runs/) | Cadence model (once/weekly/monthly/custom-N) + owner-scoped `schedules` table + create/cancel actions. The n8n Schedule Trigger that polls + fires stays hosted (described, not reproduced). |
| [`spend-gate/`](spend-gate/) | Daily token/cost cap: a `SECURITY DEFINER` `get_daily_token_spend()` RPC (service-role-only) + a single pricing-truth `cost.mjs`; the hosted gate node aborts over-cap. (Honest TE-5/Phase-4 gap: caps inert until token columns are populated.) |
| [`competitor-pricing-view/`](competitor-pricing-view/) | **Display-only** read view of the latest competitor-pricing report. The scrape pipeline/schedule/structuring is hosted recurring IP and MUST NOT appear here — the boundary exemplar (its selftest self-guards against it). |
| [`password-hygiene/`](password-hygiene/) | `checkPasswordStrength()` — rules + HaveIBeenPwned k-anonymity breach check (only the SHA-1 prefix leaves the box); fails open on outage. Zero config. |
| [`consent-log/`](consent-log/) | Server-enforced GDPR signup consent gate + server-write-only `consent_accepted_at`/`consent_version` columns (a user can't alter their own consent record). |
| [`activity-feed/`](activity-feed/) | Per-user in-app audit trail: one `logEvent()` seam + owner-read / server-insert `activity_events` table. *(New seam — a small refactor of Tessera's inline writes, not a lift-and-shift.)* |
| [`stripe-billing/`](stripe-billing/) | Stripe subscription lifecycle: signed webhook → idempotent absolute-state mirror into `profiles` + checkout/portal helpers; billing columns server-write-only. **⚠️ NOT live-wired / untested** — offline core (signature verify + event→state mapping) is selftest-proven; checkout/portal/SDK paths are reference-only and unverified against live Stripe. |

## Conventions

- **Self-contained.** Each package lives entirely under its own directory.
- **Core is pure + offline-testable.** Signing, verification, validation, and
  cadence/pricing math are Node-22 built-ins with injected clock/fetch/DB; framework
  glue (Next.js routes, Supabase queries, SDK calls) ships as clearly-marked
  `reference/` the client wires in.
- **Every webhook seam** = HMAC-SHA256 + ≤5-min replay + constant-time compare.
- **Migrations** ship RLS + REVOKE where data is sensitive; sensitive columns are
  server-write-only.
