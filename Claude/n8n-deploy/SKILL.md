---
name: n8n-deploy
description: Push a workflow from @studio/n8n-templates to the hosted n8n instance (inactive by default)
argument-hint: [<template-key>] [--activate]
allowed-tools: [Read, Bash, Grep]
user-invocable: true
---

# n8n-deploy

Provision one reusable n8n workflow TEMPLATE — composed from the
`@studio/n8n-templates` primitive library — onto the studio's hosted n8n instance
via the public API, idempotently (create or update-by-name). Default is INACTIVE;
pass `--activate` to flip it active after the write.

**BOUNDARY (read first, /studio/CLAUDE.md packages/integrations §8):** this skill
deploys a workflow definition TO the studio's OWN hosted n8n instance. It must
NEVER copy a workflow definition into a client repo. The recurring boundary is:
a client repo gets HOOKS / DISPLAY VIEWS ONLY (`features.n8n` endpoints, the
competitor-pricing read view); the workflow DEFINITIONS are the recurring IP and
live only on the hosted instance. `@studio/n8n-templates` is studio-ops infra
(same status as `@studio/notify`) — it is never imported by an `apps/*` client
build and nothing here is ever written into `clients/<name>/`. If a deploy target
that is a client repo is ever implied, stop: that is a boundary violation, not a
build to retry.

## Conventions (apply to every bash block)

- Begin with `set -euo pipefail`; quote every expansion.
- Load creds from the env file, never from chat: `set -a; . /studio/.env; set +a`.
- **Never echo a key, token, or secret value to stdout** (PAT-6 — every project
  has leaked at least one; a key seen in chat is burned and must be rotated).
  Print presence only (`[ -n "$N8N_API_KEY" ] && echo "API key: set"`), never the value.

## Procedure

### 1. Resolve the template key

The declared templates live in
`/studio/clients/_n8n-templates/config/client.config.ts` under `workflowTemplates[]`
(each entry has `key`, `name`, `expect`). The builder for each key is
`/studio/clients/_n8n-templates/builders/<key>.ts`, exporting `build(params): WorkflowDefinition`
(default export = `build`) composed only from `@studio/n8n-templates/primitives`.

```bash
set -euo pipefail
cd /studio/clients/_n8n-templates
# List available keys (no secrets involved).
grep -oE "key: '[^']+'" config/client.config.ts
ls builders/
```

- If `$ARGUMENTS` names a key, confirm both the `workflowTemplates[]` entry and
  `builders/<key>.ts` exist. The 10 known keys: `signed-webhook-base`,
  `read-only-json-api`, `notification-fanout`, `schedule-dispatcher`,
  `llm-doc-pipeline-mono`, `orchestrator-routing`, `email-report`,
  `outbound-verdict-callback`, `shopify-webhook-reread`, `sms-state-machine`.
- If no key is given, list the keys and stop — ask which one. Do not guess.
- Parse `--activate` from `$ARGUMENTS` separately (default: do NOT activate).

### 2. Confirm instance credentials (never paste them)

The hosted instance is **`csco.app.n8n.cloud` — SHARED PRODUCTION** (it also hosts
the `[TESSERA]`/`[MOSAIC]`/`[SCARLET]`/`[STUDIO_*]` families; existing workflows are
READ-ONLY). Templates go to the `PACKAGE/Templates` project
(`N8N_TEMPLATES_PROJECT_ID=IKEgTeej0upY4GVP`). Auth header is `X-N8N-API-KEY`.

```bash
set -euo pipefail
set -a; . /studio/.env; set +a
export N8N_TEMPLATES_PROJECT_ID="${N8N_TEMPLATES_PROJECT_ID:-IKEgTeej0upY4GVP}"
# Presence checks ONLY — never print the values (PAT-6).
for v in N8N_API_KEY N8N_BASE_URL N8N_TEMPLATES_PROJECT_ID; do
  if [ -n "${!v:-}" ]; then echo "$v: set"; else echo "$v: MISSING"; fi
done
```

- If `N8N_API_KEY` or `N8N_BASE_URL` is missing, stop and report — do not prompt
  for the value in chat.

### 3. Build the workflow + push via the public API

Use the package's idempotent provisioner — do NOT re-implement the API calls. The
builder returns a `WorkflowDefinition`; `provisionWorkflow` upserts it by NAME
within the project (POST create, else PUT update-by-id) and strips read-only
fields before write. `stripCredentials: true` is REQUIRED for templates — they
ship credential SLOTS (`nodeCredentialType`), not bound credential ids, or the
API rejects them as "credentials not shared with you" (EL-4).

Run the provisioner over the env (creds are read from the caller env by the
package, never hardcoded):

```bash
set -euo pipefail
set -a; . /studio/.env; set +a
cd /studio
KEY="<resolved-key>"; ACTIVATE="<true|false>"
N8N_KEY="$KEY" N8N_DO_ACTIVATE="$ACTIVATE" npx tsx /dev/stdin <<'TS'
import { provisionWorkflow, listWorkflows } from '@studio/n8n-templates/provision';
const key = process.env.N8N_KEY!;
const activate = process.env.N8N_DO_ACTIVATE === 'true';
const ctx = {
  baseUrl: process.env.N8N_BASE_URL!,
  apiKey: process.env.N8N_API_KEY!,           // read from env — never logged
  projectId: process.env.N8N_TEMPLATES_PROJECT_ID || 'IKEgTeej0upY4GVP',
};
const mod = await import(`/studio/clients/_n8n-templates/builders/${key}.ts`);
const def = (mod.default ?? mod.build)();      // WorkflowDefinition, [TEMPLATE]-prefixed
const res = await provisionWorkflow(def, {
  ...ctx,
  stripCredentials: true,                      // templates carry SLOTS, not bound ids (EL-4)
  activate,                                    // re-activate AFTER the PUT (MO-7); see step 5
});
// Round-trip verify (step 6): confirm present + active state from the live list.
const live = (await listWorkflows(ctx)).find((w) => w.id === res.id);
console.log(JSON.stringify({ id: res.id, action: res.action, name: def.name, active: live?.active ?? null }));
TS
```

### 4. Apply / confirm the PAT-3 guards

PAT-3 is the silent-no-op class: a workflow reports `success` while downstream
nodes never ran. These guards are encoded as the primitive DEFAULTS, so a builder
composed from `@studio/n8n-templates/primitives` already carries them — your job
is to CONFIRM they survived into the assembled definition, not to hand-add them:

- **`filterType: "manual"`** on every filter (`"string"` does not evaluate
  expressions → matches the whole table, TE-4).
- **Single-condition** manual filters only (multi-condition manual filters
  silently return 0 rows, TE-6 — filter the rest in a Code node).
- **`alwaysOutputData: true`** where a node can emit 0 rows (`getAll` on 0 rows
  drops the flow otherwise, TE-5).
- Stable node names in `connect` (renamed nodes leave stale refs, TE-7).

Quick confirmation against the resolved builder + primitives:

```bash
set -euo pipefail
cd /studio
grep -RnE "filterType|alwaysOutputData" \
  clients/_n8n-templates/builders/"$KEY".ts \
  packages/n8n-templates/src/primitives.ts || true
```

If any guard is absent for a node type that needs it, that is a TEMPLATE GAP in
the primitive — fix it in `packages/n8n-templates` (so every template benefits),
not inline in this deploy.

### 5. Re-activate after the PUT (only if `--activate`)

An update PUT silently clears `active` (MO-7) — activation must be a SEPARATE call
AFTER the write. `provisionWorkflow({ activate: true })` already does this
(POST `/workflows/{id}/activate` after the PUT). Confirm it ran; if the workflow
was updated and `--activate` was set, the round-trip in step 6 must show
`active: true`. Default (no `--activate`) leaves it INACTIVE — the correct state
for a freshly provisioned template.

### 6. Verify (round-trip)

The script in step 3 already re-lists the workflow by id and prints its live
`active` flag. Treat that as the source of truth:

- Present? (`id` returned, found in `listWorkflows`).
- Active state matches intent? (`active: false` by default; `active: true` only
  with `--activate`). If `--activate` was set but `active` is not `true`,
  re-activation failed — re-run the activate call, do not report success.

### 7. Report back

```
n8n template deployed: <key> → <[TEMPLATE] name>
  workflow id: <id>
  action: <created|updated>
  active: <true|false>   (inactive unless --activate)
  project: PACKAGE/Templates (IKEgTeej0upY4GVP) on csco.app.n8n.cloud
```

Never include any key/token in the report.

## Constraints

- **Config, not code.** Missing guard or behaviour → fix the primitive in
  `packages/n8n-templates`, re-run; never hand-patch the live workflow.
- **No workflow definition ever enters a client repo** (§8). This pushes to the
  hosted instance only.
- `csco.app.n8n.cloud` is SHARED PRODUCTION: only touch `[TEMPLATE]`-named
  workflows in the `PACKAGE/Templates` project; existing families are READ-ONLY.
- Default INACTIVE. Activation requires explicit `--activate`.
- Secrets: load from `/studio/.env`, presence-check only, never echo, rotate on
  exposure (PAT-6). API key flows through env into the provisioner, never the log.

## Reference

- Package: `/studio/packages/n8n-templates/` — `./primitives` (builders),
  `./provision` (`provisionWorkflow`, `listWorkflows`, `deactivateWorkflow`,
  `deleteWorkflow`).
- Declared templates + builders: `/studio/clients/_n8n-templates/config/client.config.ts`,
  `/studio/clients/_n8n-templates/builders/`.
- Footgun registry: `/studio/ERRORS_AND_FINDINGS.md` (PAT-3 guards, PAT-4 empty
  body, PAT-6 secrets, MO-7 re-activate).
- Env: `N8N_API_KEY`, `N8N_BASE_URL`, `N8N_TEMPLATES_PROJECT_ID` in `/studio/.env`.
