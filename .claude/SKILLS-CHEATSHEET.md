# IOPHON Skills Cheat Sheet

All slash-commands in `~/.claude/commands/`. Invoke as `/<name> [args]`.
Last updated: 2026-06-30.

---

## Build & deploy (studio harness)

| Skill | Does | Args | Key guardrail it encodes |
|---|---|---|---|
| `/harness-app-class` | Scaffold a NEW harness app-class + wire every registration point so the pipeline recognizes it | `<app-class-name> [--track=A\|B] [--flag=] [--kind=] [--no-package]` | Two tracks: **A** studio-ops template class (n8n/supabase-template) vs **B** served-app class (research/webApp). Preflight greps for an existing flag/add-on and STOPS on a duplicate. Never edits run/orchestrator/evaluator/planner. |
| `/deploy-vercel` | Take an already-built client app live on Vercel | `[<app/client>] [--prod] [--preview]` | Blocking gates: confirm the **real project ID** (never trust `/studio/.env`'s storefront-pointing vars); PAT-7 (`proxy.ts` not `middleware.ts`); PAT-8 (`.vercelignore` for core dumps, 2 GiB limit). |
| `/db-migrate` | Apply a Supabase migration over HTTPS + verify | `[<migration-file-or-sql>] [--project=<ref>]` | PAT-5: psql is unreachable — apply DDL via the Management API query endpoint (`sbp_` PAT). Verifies the object landed AND that every new table has RLS (a table without RLS = hard finding). |
| `/n8n-deploy` | Push a workflow from `@studio/n8n-templates` to the hosted n8n instance | `[<template-key>] [--activate]` | Inactive by default. PAT-3 guards (`filterType:"manual"`, `alwaysOutputData:true`, re-activate after PUT). §8 boundary: deploys to the hosted instance only, NEVER copies a definition into a client repo. No secrets echoed. |

## Repo operations

| Skill | Does | Args | Key guardrail |
|---|---|---|---|
| `/dependabot-triage` | List, group, gate-on-CI, and batch-merge Dependabot PRs across 4R1U5-RCL | `[<repo>] [--merge] [--dry-run]` | Dry-run by default; only green **patch/minor** auto-merge; majors + pre-1.0 minors + red CI held for review. |
| `/ci-add-to-board` | Wire `actions/add-to-project` CI so new issues/PRs auto-add to a Projects board | `<repo> [--board=<url>]` | Resolves repo→board (tessera→projects/1, else→projects/2); needs the `ADD_TO_PROJECT_PAT` secret; commits on a branch + PR, never direct-to-main; pins the action version. |

## Security & diagnostics

| Skill | Does | Args | Key guardrail |
|---|---|---|---|
| `/app-security-audit` | App-surface security audit (RLS + response headers + SCA) of a built client repo | `[<repo-or-path>] [--client=<slug>]` | Runs `~/packages/audit` cross-surface; checks §8.1 (no Shopify mirror), RLS coverage, REVOKE, headers, SCA. Sits **upstream** of the harness `verify` stage — diagnostic, not a replacement. |
| `/diagnose-secret` | Diagnose a secret that looks right but 401s at runtime | `<secret-name-or-env-var> [--project=<ref>]` | Narrows to one of the 4 PAT-11 causes (truncation / wrong-project / stale-desync / legacy-key-off). Probes `/rest/v1/` specifically. **Never echoes the value** — length + fingerprint + status codes only (PAT-6). |

## Session & knowledge management

| Skill | Does | Output |
|---|---|---|
| `/handoff` | Compile the current session into a handoff doc (incremental if <4h since last) | `~/.claude/data/handoffs/` |
| `/debrief` | Compile multiple parallel-session handoffs into one terminal-ready report | `~/.claude/data/debriefs/` |
| `/batch` | Read open tasks/handoffs, rank by severity, group into session batches, write delegation handoffs | `~/.claude/data/handoffs/` |
| `/align` | Append date-stamped change entries to the core infra docs | `~/.claude/data/documents/` |
| `/research` | Answer a question via Claude→GPT-5→Gemini (+Perplexity) chain, scored by inter-model agreement | `~/.claude/data/research/` |
| `/validate` | Cross-validate Claude's output against GPT-5/Gemini via the LiteLLM proxy | `~/.claude/data/validate/` |

## System maintenance

| Skill | Does | Output |
|---|---|---|
| `/audit` | Comprehensive IOPHON system audit (security/network/permission/system) | `~/.claude/data/audits/` |
| `/backup` | Tar.gz `~/.claude/` + Dreamworld dirs, prompt for off-system copy | `~/.claude/data/backups/` |
| `/cleanup` | Move stray files in `~/.claude/` to their correct subdirs per CLAUDE.md §2 | reorganizes in place |

---

## Notes

- **New this session (2026-06-30):** the first 8 in the top three tables — distilled from recurring work across the Tessera/Harness GitHub PRs, 133 handoffs, and the `ERRORS_AND_FINDINGS.md` registry. Each folds a documented error class (PAT-*) into a blocking preflight.
- **Built-ins** (not in this list, ship with Claude Code): `/verify`, `/code-review`, `/security-review`, `/simplify`, `/run`, `/loop`, `/schedule`, `/deep-research`. The new skills sit *upstream* of `/verify` — they're operator diagnostics/actions, not re-implementations of the harness verify stages.
- **Error patterns referenced** (`/studio/ERRORS_AND_FINDINGS.md`): PAT-3 n8n silent no-ops · PAT-5 Postgres-unreachable-migrate-over-HTTPS · PAT-6 secrets-in-chat · PAT-7 proxy.ts-vs-middleware · PAT-8 2GiB-core-dump-upload · PAT-11 secret-looks-right-but-401s.
