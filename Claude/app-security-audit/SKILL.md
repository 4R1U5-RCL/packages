---
name: app-security-audit
description: App-surface security audit (RLS + response headers + SCA) against a built client repo, via ~/packages/audit
argument-hint: [<repo-or-path>] [--client=<slug>]
allowed-tools: [Read, Bash, Grep]
user-invocable: true
---

# app-security-audit

Run an **app-surface** security audit against a built client repo or sandbox: RLS
policy coverage, HTTP response-headers, and software-composition (SCA / Dependabot)
checks. This is a variant of the system `/audit` (same family, same house style) but
pointed at a *delivered application*, not the IOPHON installation itself.

**Where this sits.** This is an OPERATOR DIAGNOSTIC that sits *upstream* of the
harness `verify` stages — not a re-implementation of them. The harness evaluator
runs its own app-scoped manifests during the pipeline; this skill is the
authoritative loop-closer you run *after* a build or a security fix, because
`~/packages/audit` reads `.github/` + `next.config.ts` on disk (cross-surface) which
the evaluator's app-scoped manifest historically could not. Treat its verdicts as a
second, independent opinion — never as a substitute for the pipeline's `verify`.

## Shell hardening conventions (applies to all bash blocks below)

All bash invocations in these checks must:

- Begin with `set -euo pipefail` so pipe failures do not silently pass.
- Quote every variable expansion: `"$HOME"`, `"$TARGET"`, never bare `$VAR`.
- Use `"$HOME/..."` instead of literal `/home/...` paths.
- **Never print matched secret values to stdout/report output** — file paths,
  lengths, and fingerprints only (`grep -l`, never `grep` with the value echoed).
- A `pass` from `~/packages/audit` is only real when its `negative_control` shows
  `injected:true, fired:true`. An unguarded pass is downgraded to `unknown` — report
  it as `unknown`, never as a clean pass.

## Procedure

### 1. Parse arguments

- `<repo-or-path>` — path to the built client repo / sandbox to audit (the
  `--target` for the audit tool). Required for repo + app:static checks.
- `--client=<slug>` — client slug, used only to locate the infra config (below) and
  to label the report. Optional.
- If no target is given, ask for one — do not guess a path.

Resolve the infra config for dynamic checks if present:
`~/packages/audit/scheduled/infra.config.<slug>.json` (argv with `$ENV` tokens;
example shape at `~/packages/audit/scheduled/infra.config.example.json`). Without a
config, infra + app:dynamic controls return honest `unknown`, never a silent pass.

### 2. Run the `~/packages/audit` tool cross-surface

`~/packages/audit/` (= `/root/packages/audit/`) is the self-guarding,
ATT&CK×ISO27001×SOC2-mapped audit tool. It is NOT in the `/studio` repo. Dispatcher
is `run.mjs`. `SKILL.md` + `manifests/*.json` are canonical for scope.

```bash
set -euo pipefail
TARGET="<repo-or-path>"
# Full cross-surface run. Repo + app:static need only --target; infra + app:dynamic
# need --config (omit it and those controls return `unknown`, not a false pass).
node "$HOME/packages/audit/run.mjs" --surface all --target "$TARGET" \
  ${CONFIG:+--config "$CONFIG"}
```

- Each control emits one JSON line. Parse with `python3` (not `jq` — see PAT-9).
- To prove a single detector, run one control with `--self-test`:
  `node "$HOME/packages/audit/checks/<control>.mjs" --target "$TARGET" --self-test`.
- Relevant controls: `rls`, `revoke`, `secret-leak` (repo); `security-headers`,
  `dependency-audit`, `app-logging` (app:static); `access-probe`, `cookie-flags`,
  `ssrf`, `webhook-auth`, `dns-auth`, `supabase-logging` (dynamic).

### 3. RLS checks (cross-checked against the §8.1 boundary)

These mirror `packages/db`'s hard constraints (`/studio/CLAUDE.md`). The audit
tool's `rls`/`revoke` controls do the detection; this section is what their output
must satisfy.

1. **Every table has an RLS policy.** No table is left world-readable. A missing or
   loose policy is a HARD finding — for builds capturing leads/form data, a
   permission leak is a real data-exposure bug in delivered work.
2. **REVOKE present where sensitive columns exist** (the discipline gap that let
   Tessera's DEFECT-1 through).
3. **No table mirrors Shopify order/stock/payment fields as a source of truth**
   (baseline §8.1). Supabase holds only three shapes: app data Shopify doesn't own,
   short-lived reconciled caches, and derived history. Any table duplicating
   Shopify's live commercial state is a finding.

- **GOTCHA (report as `unknown`, not PASS or FAIL):** `rls`/`revoke` are anchored on
  `CREATE TABLE`. A client whose base tables live out-of-repo (e.g. Tessera's
  `profiles`/`tasks` created in Supabase, with migrations that only `ALTER`) yields
  `unknown` even when RLS policies genuinely exist. Do NOT read that as a pass and do
  NOT read it as a failure — flag it for a live-probe / Management-API confirmation.

### 4. HTTP response-headers check (`security-headers` control)

Confirm the delivered app sets the expected security response headers (read from
`next.config.ts` on disk and/or a live response):

- `Content-Security-Policy` (CSP) present and not trivially permissive.
- `Strict-Transport-Security` (HSTS).
- `X-Frame-Options` (or CSP `frame-ancestors`).
- `X-Content-Type-Options: nosniff`, `Referrer-Policy`.

- **PASS:** required headers present and sane.
- **WARNING:** present but weak (e.g. CSP with broad `unsafe-inline`).
- **FAIL:** a required header missing.

### 5. SCA / Dependabot enablement check (`dependency-audit` control)

- Confirm software-composition scanning is wired: `.github/dependabot.yml` present
  and covering the package ecosystems in use, and/or a dependency-audit step in CI.
- Confirm no known-vulnerable dependencies are flagged by the control's output.
- **PASS:** Dependabot (or equivalent SCA) enabled and no open high/critical advisories.
- **WARNING:** SCA enabled but advisories outstanding.
- **FAIL:** No SCA configured for a delivered client app.

### 6. Report findings by severity

Compile a findings summary grouped by severity. Match the `/audit` report shape:

```markdown
# App-Security Audit — <client/repo> — <Date (UTC)>

## Overview
| Surface | Control | Status | Detail |
|---|---|---|---|
| repo | rls | ✗ FAIL | table `leads` has no policy |
| app:static | security-headers | ⚠ WARNING | CSP present, `unsafe-inline` |
| app:static | dependency-audit | ✓ PASS | Dependabot enabled, 0 advisories |
| repo | revoke | ? UNKNOWN | base tables out-of-repo (CREATE TABLE gotcha) |

## Findings by severity
### CRITICAL
- <control>: <finding> — <fix>
### WARNING
- <control>: <finding> — <recommendation>
### UNKNOWN (needs live confirmation)
- <control>: <why it could not be determined>

## Summary
Critical: N | Warnings: M | Passes: K | Unknown: U
Overall: <SECURE | WARNINGS | CRITICAL>
```

- Severity from the control verdicts: any FAIL → `CRITICAL`; WARNINGs only →
  `WARNINGS`; all PASS (with genuine `negative_control` firing) → `SECURE`.
- List every `unknown` explicitly with its cause — an unguarded pass or an
  out-of-repo `CREATE TABLE` is `unknown`, never silently dropped.

## Constraints

- **Read-only.** This audit never modifies the target repo. It runs the audit tool,
  reads files, and reports.
- **Never print secret values** to output — file paths, lengths, fingerprints only
  (PAT-6). The `secret-leak` control reports locations, not values.
- **Upstream of, not a replacement for, `verify`.** The harness evaluator's `verify`
  stages remain the pipeline source of truth for pass/fail. This is an operator
  diagnostic that runs the cross-surface tool the evaluator's manifest cannot.
- A `pass` is only real when `negative_control` fired (`injected:true, fired:true`);
  otherwise report `unknown`.
- `~/packages/audit` is NOT in `/studio` — do not look for it under the repo.
- Use `python3` to parse the JSON-line output (no `jq` in the container, PAT-9).

## Reference

- Audit tool: `~/packages/audit/` — dispatcher `run.mjs`; scope in `SKILL.md` +
  `manifests/*.json`; infra config example `scheduled/infra.config.example.json`.
- RLS / §8.1 boundary: `/studio/CLAUDE.md` (`packages/db` section).
- Related: the system `/audit` (IOPHON installation, not client apps); the harness
  `verify` stages (pipeline source of truth).
