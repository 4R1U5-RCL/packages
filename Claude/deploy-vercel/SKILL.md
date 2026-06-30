---
name: deploy-vercel
description: Deploy a client app to Vercel with an explicit project-ID, env/secret, and known-trap preflight checklist
argument-hint: [<app/client>] [--prod] [--preview]
allowed-tools: [Read, Bash, Grep]
user-invocable: true
---

# deploy-vercel

Deploy a client app (e.g. `/studio/clients/tessera`) to Vercel safely. The
hazards here are not the deploy command itself — they are deploying to the
WRONG project (the `/studio/.env` trap), and two recurring build/upload failures
(`middleware.ts`/`proxy.ts` collision, and 2 GiB core dumps). This skill encodes
each as a **blocking gate**: if a gate fails, STOP and report — do not deploy.

This is a deploy aid, not a substitute for the harness. Build work itself goes
through the planner → generator → evaluator pipeline (CLAUDE.md §1.6); this skill
only takes already-built output live.

## Conventions (applies to all bash blocks)

- Begin every block with `set -euo pipefail`; quote every expansion.
- The Vercel token comes from `/studio/.env` (`VERCEL_TOKEN`) — never print it.
- A failed gate exits non-zero and BLOCKS the deploy. Do not "fix and retry"
  past a boundary gate; surface it and stop.

## Procedure

### 1. Resolve the app directory and target

- `$ARGUMENTS` names the app/client. Default working dir convention is
  `/studio/clients/<name>` (Tessera lives at `/studio/clients/tessera`, app code
  in `apps/web`).
- `--prod` → production deploy; `--preview` (or no flag) → preview deploy.
- Confirm the directory exists before going further:
  ```bash
  set -euo pipefail
  APP_DIR="/studio/clients/${CLIENT}"
  [ -d "$APP_DIR" ] || { echo "BLOCK: app dir $APP_DIR not found"; exit 1; }
  ```

### 2. GATE A — Confirm the correct Vercel project ID/target (NEVER trust `/studio/.env`)

`/studio/.env`'s `VERCEL_PROJECT_ID` / `VERCEL_ORG_ID` point at the harness
**`studio-storefront`** project (`prj_oFVIrIDvZeW7P5u26vYQP9KcIinI`, rootDir
`apps/storefront`) — NOT the client. Deploying with those set verbatim builds the
wrong app and fails with `apps/web/apps/storefront does not exist`. Confirmed
2026-06-27.

- The **single source of truth for the target is the repo's `.vercel/project.json`
  link**, not the env vars. Read it and confirm it matches the intended client:
  ```bash
  set -euo pipefail
  cat "$APP_DIR/.vercel/project.json"   # projectId + orgId the link actually uses
  ```
- Known-good Tessera target (team `rcl` = `team_Txmx3JvzXjV8jsOBxttrkMjJ`):
  - `studio-tessera-web` = `prj_pdGYdOfUOyQwPEIOOsFRlMwB3DQj`, rootDir `apps/web`.
- **The blocking rule:** confirm the project ID/slug explicitly before deploy.
  The safe path is to `source /studio/.env` for `VERCEL_TOKEN`, then
  **`unset VERCEL_PROJECT_ID VERCEL_ORG_ID`** so the repo's `.vercel` link wins
  (confirmed 2026-06-28). Leaving them set targets `studio-storefront`.
  ```bash
  set -euo pipefail
  set -a; . /studio/.env; set +a
  unset VERCEL_PROJECT_ID VERCEL_ORG_ID   # drop the trap vars
  ```
- **GATE:** if you cannot positively confirm the resolved project is the intended
  client (e.g. no `.vercel/project.json`, or it resolves to `studio-storefront`
  when you meant Tessera), BLOCK and ask the user to confirm the project ID. Note:
  the MCP Vercel connector cannot see `studio-tessera-web` (404) — use the
  CLI/`.vercel` link to verify, not the connector.

### 3. GATE B — Preflight: known traps (each blocks deploy)

#### 3a. `proxy.ts`, not `middleware.ts` (PAT-7, Next.js 16)

A `middleware.ts` re-export shim collides with Next 16's `proxy.ts` entrypoint and
fails the build with `Both middleware file and proxy file detected` (hit in
Tessera TE-14, Mosaic MO-9). Use `proxy.ts` directly; the `middleware.ts` shim
must be deleted.
```bash
set -euo pipefail
if [ -f "$APP_DIR/apps/web/middleware.ts" ] && [ -f "$APP_DIR/apps/web/proxy.ts" ]; then
  echo "BLOCK (PAT-7): both middleware.ts and proxy.ts present — delete the middleware.ts shim"; exit 1
fi
```
**GATE:** both files present → BLOCK.

#### 3b. `.vercelignore` present, no core dumps in the upload (PAT-8)

Linux `core.<pid>` dumps (2.1–2.35 GB) in the project root blow Vercel's 2 GiB
upload limit and fail the deploy with `File size > 2 GiB` (Tessera TE-14, Mosaic
MO-2). Every scaffold must ship a `.vercelignore` containing `core.*`, `*.core`,
`node_modules`, `.next`.
```bash
set -euo pipefail
[ -f "$APP_DIR/.vercelignore" ] || { echo "BLOCK (PAT-8): no .vercelignore — add core.* *.core node_modules .next"; exit 1; }
for pat in 'core.*' '*.core' 'node_modules' '.next'; do
  grep -qF "$pat" "$APP_DIR/.vercelignore" || { echo "BLOCK (PAT-8): .vercelignore missing entry: $pat"; exit 1; }
done
# Confirm no large core dumps are actually sitting in the tree
find "$APP_DIR" \( -name 'core.*' -o -name '*.core' \) -type f -size +100M -print | grep . \
  && { echo "BLOCK (PAT-8): core dump(s) in tree — delete before deploy"; exit 1; } || true
```
**GATE:** missing `.vercelignore`, missing entry, or a real core dump present → BLOCK.

#### 3c. Env / secrets present and pointed at the right project

- Confirm `VERCEL_TOKEN` is loaded (from step 2). Confirm the app's runtime env
  (e.g. `NEXT_PUBLIC_SUPABASE_URL`, Supabase keys) targets the CLIENT's project,
  not `SUPABASE_STAGING_PROJECT_REF`. Key off the project named by the client's
  own `NEXT_PUBLIC_SUPABASE_URL` (Tessera = `egdz...` "studio/tessera"), never the
  staging ref (`plqr...`) — wrong-project keys return 401 and mimic an outage
  (TE-18).
  ```bash
  set -euo pipefail
  [ -n "${VERCEL_TOKEN:-}" ] || { echo "BLOCK: VERCEL_TOKEN not loaded from /studio/.env"; exit 1; }
  grep -E 'NEXT_PUBLIC_SUPABASE_URL' "$APP_DIR/apps/web/.env.local" 2>/dev/null || \
    echo "WARN: confirm runtime env points at the client project, not staging"
  ```
- Reminder (TE-21): a Supabase key rotation must ALSO update the hosted n8n
  credentials — out of scope for deploy, but flag it if keys changed recently.
**GATE:** `VERCEL_TOKEN` missing → BLOCK. Env pointed at the wrong project → BLOCK.

### 4. Build

Tessera is a CLI-prebuilt deploy with **no Git link** — run `vercel build` from
the repo ROOT (not `apps/web`); Vercel applies the rootDir, else you get
`apps/web/apps/web` (TE-21).
```bash
set -euo pipefail
cd "$APP_DIR"
vercel pull --yes --environment="${VERCEL_ENV:-production}" --token "$VERCEL_TOKEN"
if [ "$IS_PROD" = "1" ]; then
  vercel build --prod --token "$VERCEL_TOKEN"
else
  vercel build --token "$VERCEL_TOKEN"
fi
```
If the build fails, re-check GATE B (PAT-7 is a build-time signature). Do not
deploy a failed build.

### 5. Deploy (preview vs prod from args)

```bash
set -euo pipefail
cd "$APP_DIR"
if [ "$IS_PROD" = "1" ]; then
  DEPLOY_URL=$(vercel deploy --prebuilt --prod --yes --token "$VERCEL_TOKEN")
else
  DEPLOY_URL=$(vercel deploy --prebuilt --yes --token "$VERCEL_TOKEN")
fi
echo "Deployed: $DEPLOY_URL"
```
A prod deploy auto-aliases the project's domain (Tessera prod → custom domain
`tessera-project.dev`, also `studio-tessera-web.vercel.app`), so relative links
like `/pvcy` `/tcs` resolve there.

### 6. Verify live + smoke-check

```bash
set -euo pipefail
# Deployment should return 2xx/3xx, not 404/5xx
curl -sS -o /dev/null -w '%{http_code}\n' "$DEPLOY_URL"
```
- Confirm the URL is reachable and returns a success/redirect status, not an
  error. For prod, also hit the aliased custom domain.
- Optionally confirm a known route renders (e.g. the home page and one
  app-specific path). If the deploy 404s or 5xxs, treat it as failed and report —
  do not alias/promote a broken deploy.

### 7. Report back

```
Deploy complete: <DEPLOY_URL>   (alias: <custom domain, if prod>)
Target: <project-slug> = <prj_...>  (team rcl = team_Txmx3JvzXjV8jsOBxttrkMjJ)
Mode: <prod | preview>

Gates:
- A (project ID confirmed, trap vars unset): PASS
- B (proxy.ts not middleware.ts / .vercelignore + no core dumps / env→right project): PASS
Smoke check: <HTTP status>
```

If any gate BLOCKED, report which one and why, and STOP — no deploy was issued.

## Constraints

- Never print `VERCEL_TOKEN` or any secret value.
- Never trust `/studio/.env`'s `VERCEL_PROJECT_ID`/`VERCEL_ORG_ID` — confirm the
  target from the repo `.vercel` link and unset the trap vars (Gate A).
- A failed gate BLOCKS the deploy. Do not bypass a boundary gate to "make it ship."
- This skill deploys already-built client output; it does not author or edit
  client code — that goes through the harness pipeline (CLAUDE.md §1.6).

## Reference

- Tessera Vercel target: `studio-tessera-web` = `prj_pdGYdOfUOyQwPEIOOsFRlMwB3DQj`,
  team `rcl` = `team_Txmx3JvzXjV8jsOBxttrkMjJ`, rootDir `apps/web`.
- Trap project: `studio-storefront` = `prj_oFVIrIDvZeW7P5u26vYQP9KcIinI`.
- Memory: `~/.claude/projects/-studio/memory/project_studio-tessera-vercel.md`.
- Traps: `/studio/ERRORS_AND_FINDINGS.md` — PAT-7, PAT-8 (also TE-18, TE-21).
