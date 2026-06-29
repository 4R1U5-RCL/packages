# packages — reusable studio tooling

Standalone, reusable tooling that serves the studio but isn't part of any single
client build or the harness. Each package is self-contained and is **consumed by
pulling a pinned version**, never copy-forked into a container.

## Layout

- **[`Claude/`](Claude/)** — agent-side tooling for the studio (4 packages).
- **[`Webapp/`](Webapp/)** — reusable web-app feature-packages extracted from Tessera
  (11 packages — see [`Webapp/README.md`](Webapp/README.md)).
- **[`n8n/`](n8n/)** — hosted n8n workflow **templates** (10 importable workflow
  definitions for the studio's own instance — see [`n8n/README.md`](n8n/README.md)).

## `Claude/` — agent-side tooling

| Package | What it is |
|---------|------------|
| [`Claude/audit/`](Claude/audit/) | ATT&CK × ISO 27001 × SOC 2 security verification for the studio stack — a deterministic check core with three entry points (agent skill, CI gate, scheduled runner). Every check is self-guarded so a pass is earned, never assumed. |
| [`Claude/hygiene/`](Claude/hygiene/) | Config/codebase hygiene across three pluggable profiles (`claude` home-tree relocation, `codebase` git-aware backup + junk-drift report, `llm-artifacts` transcript backup). `cleanup` drift detector + self-verifying `backup`; report-only on non-`claude` profiles. Self-guarded so a pass is earned. |
| [`Claude/consult/`](Claude/consult/) | Multi-model cross-validation — `research` + `validate` over one LiteLLM chain (base → GPT-5 → Gemini, optional Perplexity). Self-guarded offline; a corroborated/HIGH verdict needs the tiers to have actually responded, else `unknown` — never a fabricated answer. |
| [`Claude/notify/`](Claude/notify/) | Claude Code → Telegram notifier. A `Notification`/`Stop` hook POSTs a signed event to the hosted `[STUDIO_NOTIFICATIONS]` n8n workflow, which pings Telegram (🟡 needs input / 🟢 done). Header-Auth + HMAC-signed; the live channel is proven via the n8n executions API. |

## `Webapp/` — web-app feature-packages (from Tessera)

Self-contained, env-driven, HMAC + ≤5-min replay on every webhook seam, with an
offline `selftest.mjs` whose pass is earned. **Recurring boundary:** n8n workflow
*definitions* stay hosted; packages ship only the signed hook/route, a display
view, migrations, and a doc of the matching n8n node.

| Package | What it is | Status |
|---------|------------|--------|
| [`Webapp/n8n-trigger/`](Webapp/n8n-trigger/) | **Foundational** signed-webhook seam: server-only client firing a hosted n8n workflow (timestamped HMAC) + the inbound verifier. The pattern the other n8n features reuse. | selftest ✓ |
| [`Webapp/inbound-email/`](Webapp/inbound-email/) | Resend inbound webhook → Svix raw-body HMAC verify (±5-min replay) → fetch message → forward with `reply_to`=sender. Idempotent DNS provision; route must be a `PUBLIC_PATHS` entry. | selftest ✓ |
| [`Webapp/transactional-email/`](Webapp/transactional-email/) | `sendEmail(to,subject,html,attachment?)` via the Resend REST API with recipient validation + fail-soft no-op. | selftest ✓ |
| [`Webapp/usage-quota/`](Webapp/usage-quota/) | Rolling-window usage limiter over any countable resource, with Pro + dev-allow-list exemptions; enforces at the action boundary. | selftest ✓ |
| [`Webapp/scheduled-runs/`](Webapp/scheduled-runs/) | Cadence model (once/weekly/monthly/custom-N) + owner-scoped `schedules` table + create/cancel actions. The n8n Schedule Trigger stays hosted. | selftest ✓ |
| [`Webapp/spend-gate/`](Webapp/spend-gate/) | Daily token/cost cap: `SECURITY DEFINER` `get_daily_token_spend()` RPC + a single pricing-truth module; the hosted gate node aborts over-cap. (Honest TE-5/Phase-4 gap: caps inert until token columns populated.) | selftest ✓ |
| [`Webapp/competitor-pricing-view/`](Webapp/competitor-pricing-view/) | **Display-only** read view of the latest competitor-pricing report. Scrape pipeline/schedule/structuring is hosted recurring IP and must not appear here — the boundary exemplar. | selftest ✓ |
| [`Webapp/password-hygiene/`](Webapp/password-hygiene/) | `checkPasswordStrength()` — rules + HaveIBeenPwned k-anonymity breach check (only the SHA-1 prefix leaves the box); fails open. Zero config. | selftest ✓ |
| [`Webapp/consent-log/`](Webapp/consent-log/) | Server-enforced GDPR signup consent gate + server-write-only `consent_accepted_at`/`consent_version` columns. | selftest ✓ |
| [`Webapp/activity-feed/`](Webapp/activity-feed/) | Per-user in-app audit trail: one `logEvent()` seam + owner-read / server-insert `activity_events` table. *(New seam — a refactor of Tessera's inline writes.)* | selftest ✓ |
| [`Webapp/stripe-billing/`](Webapp/stripe-billing/) | Stripe subscription lifecycle: signed webhook → idempotent absolute-state mirror into `profiles` + checkout/portal helpers; billing columns server-write-only. | ⚠️ **NOT live-wired / untested** — offline core only |

## `n8n/` — hosted workflow templates

Reusable n8n workflow **templates** for the studio's OWN hosted instance —
importable node-graph definitions distilled from the live workflows
(`[STUDIO_TESSERA]`, `[STUDIO_NOTIFICATIONS]`, `[TESSERA]`, `[MOSAIC]`,
`[SCARLET]`). **Boundary, the other side of `Webapp/`:** `Webapp/` ships only the
signed *hook/route* a client app uses to call a hosted workflow; `n8n/` is the
hosted *definitions* themselves — studio-ops recurring IP, never copied into a
client repo. Templates ship **inactive** with **unbound credential slots**;
binding creds + activating is a deliberate human/ops step.

Authored as code in the studio monorepo (`@studio/n8n-templates` primitives + the
harness `n8n-template` app-class) and provisioned to the hosted `PACKAGE/Templates`
project; this dir is the published, importable snapshot. See
[`n8n/README.md`](n8n/README.md).

| Template | Pattern |
|----------|---------|
| [`signed-webhook-base`](n8n/workflows/signed-webhook-base.json) | Base skeleton: webhook → dual-mode HMAC verify → 401 gate → fast ack → process → signed respond. |
| [`read-only-json-api`](n8n/workflows/read-only-json-api.json) | GET webhook → Supabase REST select → shape → respond. |
| [`notification-fanout`](n8n/workflows/notification-fanout.json) | verify → format → channel-parameterised delivery → respond after delivery. |
| [`schedule-dispatcher`](n8n/workflows/schedule-dispatcher.json) | cron → query due rows → manual filter → fire webhook → write-back. |
| [`llm-doc-pipeline-mono`](n8n/workflows/llm-doc-pipeline-mono.json) | analyse → map/scrape → combine → compose → store, with cost logging + spend guard (OpenRouter HTTP). |
| [`orchestrator-routing`](n8n/workflows/orchestrator-routing.json) | webhook → switch on type → `executeWorkflow` dispatch to children. |
| [`email-report`](n8n/workflows/email-report.json) | validate → compose → Resend `/emails` → log success/failure → respond. |
| [`outbound-verdict-callback`](n8n/workflows/outbound-verdict-callback.json) | push to external webapp → read verdict → map → re-enter pipeline. |
| [`shopify-webhook-reread`](n8n/workflows/shopify-webhook-reread.json) | Shopify HMAC verify → live re-read / cache invalidate → respond. **Never mirrors** commercial state. |
| [`sms-state-machine`](n8n/workflows/sms-state-machine.json) | inbound → STOP/dedupe guards → identity/session lookup → AI decision → outbound + provider flag. |

## Conventions

- **Self-contained.** A package lives entirely under its own directory; nothing it
  needs sits elsewhere in the tree.
- **Pinned consumption.** Consumers pull a tagged version and reference it in
  place. Bump the pin deliberately. (The first tag is `v0.1.0`.)
- **Earned green.** Every package's `selftest.mjs` proves real behaviour (negative
  controls fire); a pass is never "ran without error". One exception is flagged
  above: `stripe-billing` is offline-proven but **not yet tested against live APIs**.
