# n8n — hosted workflow templates

Reusable n8n workflow **templates** for the studio's own hosted instance — a
top-level sibling of [`Claude/`](../Claude/) and [`Webapp/`](../Webapp/). Each
template is a node-graph pattern distilled from the workflows we actually run
(`[STUDIO_TESSERA]`, `[STUDIO_NOTIFICATIONS]`, `[TESSERA]`, `[MOSAIC]`,
`[SCARLET]`) — built once to be the starting point and reference shape for future
workflow builds.

**Boundary — the other side of `Webapp/`.** `Webapp/` packages (e.g.
[`Webapp/n8n-trigger`](../Webapp/n8n-trigger/),
[`Webapp/competitor-pricing-view`](../Webapp/competitor-pricing-view/)) ship only
the signed *hook/route/display view* a client app uses to call or show a hosted
workflow — the workflow *definition* stays hosted. **`n8n/` is those hosted
definitions.** They are studio-ops recurring IP and live here (the studio's own
repo), never copied into a client-delivered repo — exactly as `@studio/notify`
provisions its workflow as code.

These are **templates, not live workflows**: they ship **inactive** and with
**unbound credential slots** (`nodeCredentialType` only) and `$env`/parameter
placeholders. Binding credentials and activating is a deliberate human/ops step
when a template is instantiated for a specific job.

> Source of truth: exported from the hosted `PACKAGE/Templates` n8n project
> (`IKEgTeej0upY4GVP`). Authored as code in the studio monorepo
> (`@studio/n8n-templates` primitives + `clients/_n8n-templates/builders/`) and
> built/verified/provisioned through the harness `n8n-template` app-class — never
> hand-drawn. This dir is the published, importable snapshot.

## Templates

| File | Template | Pattern |
|------|----------|---------|
| [`workflows/signed-webhook-base.json`](workflows/signed-webhook-base.json) | Signed Webhook → Ack → Process → Respond | The base skeleton: webhook → HMAC verify (dual-mode) → 401 gate → fast ack → process → signed respond. Every other webhook template extends it. |
| [`workflows/read-only-json-api.json`](workflows/read-only-json-api.json) | Read-only JSON API | GET webhook → Supabase REST select → shape → respond. (MOSAIC list/get shape.) |
| [`workflows/notification-fanout.json`](workflows/notification-fanout.json) | Notification Fan-out | verify → format → channel-parameterised delivery → respond after delivery. (Generalises `[STUDIO_NOTIFICATIONS]`.) |
| [`workflows/schedule-dispatcher.json`](workflows/schedule-dispatcher.json) | Schedule Dispatcher | cron → query due rows → manual filter → fire webhook → write-back. (`[STUDIO_TESSERA] SCHEDULE`.) |
| [`workflows/llm-doc-pipeline-mono.json`](workflows/llm-doc-pipeline-mono.json) | LLM Document Pipeline — Monolithic | analyse → map/scrape → combine → compose → store, with per-stage cost logging + daily spend guard. LLM calls are plain OpenRouter HTTP nodes. |
| [`workflows/orchestrator-routing.json`](workflows/orchestrator-routing.json) | Orchestrator + Sub-workflow Routing | webhook → switch on request type → `executeWorkflow` dispatch to children. (`[TESSERA] INBOUND WF2`.) |
| [`workflows/email-report.json`](workflows/email-report.json) | Email Report | validate → compose → Resend `/emails` → log success/failure → respond. |
| [`workflows/outbound-verdict-callback.json`](workflows/outbound-verdict-callback.json) | Outbound Dispatch + Verdict Callback | push to external webapp → read verdict → map → re-enter pipeline. (`[TESSERA] OUTBOUND WF1`.) |
| [`workflows/shopify-webhook-reread.json`](workflows/shopify-webhook-reread.json) | Shopify Webhook → Re-read/Invalidate | Shopify HMAC verify (base64) → live re-read / cache invalidate → respond. **Never mirrors** order/stock/payment state. |
| [`workflows/sms-state-machine.json`](workflows/sms-state-machine.json) | SMS/WhatsApp State Machine | inbound → STOP/dedupe guards → identity/session lookup → AI decision → outbound + provider flag. (`[SCARLET]` lineage.) |

## Conventions baked into every template

- **Signing.** Default to the studio HMAC form — `HMAC(${ts}.${body})` with
  `x-n8n-timestamp` + `x-n8n-signature`, lowercase hex, ±5 min skew, fail-closed.
  The verify node is **dual-mode**: it branches on the presence of
  `x-n8n-timestamp` so it also accepts the bare-body form the harness `verify-n8n`
  round-trip uses.
- **n8n footguns are the defaults** (studio `ERRORS_AND_FINDINGS.md`): manual,
  single-condition filters with `alwaysOutputData`; `fullResponse` + `neverError`
  on HTTP nodes with a `JSON.parse` guard; a 401 If-guard on webhooks; stable node
  names; re-activate after any API PUT.
- **No secrets, no hardcoded URLs.** Credentials are unbound slots; instance URLs
  and tokens are `$env`/parameter placeholders. Bind them at instantiation.
- **Boundaries.** Templates trigger/display and read live; they do **not** embed
  scraping/structuring pipelines, and never write Shopify's commercial state into
  Supabase as a source of truth.

## Using a template

1. In n8n: **Workflows → Import from File** and pick the JSON (or `POST
   /api/v1/workflows` with the body).
2. Bind the credential on each node that shows an empty slot.
3. Set the instance env vars / parameters the nodes reference (webhook secret,
   Supabase URL, model, channel ids, etc.).
4. Rename + activate when ready. Keep the `[TEMPLATE]` originals inactive.

To regenerate this snapshot, re-export the `PACKAGE/Templates` workflows or re-run
the harness `n8n-template` build (idempotent provisioning).
