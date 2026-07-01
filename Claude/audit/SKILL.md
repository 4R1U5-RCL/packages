---
name: security-audit
description: Run an ATT&CK-mapped security audit of the studio stack across three surfaces — repo (RLS/REVOKE, committed-secret hygiene), infra (SSRF, webhook HMAC auth, email SPF/DKIM/DMARC, logging/detection config), and app (OWASP Top 10 against the delivered web app: access control/IDOR, security headers, dependency CVEs, cookie flags, app-side logging) — mapped to MITRE ATT&CK × ISO 27001:2022 × SOC 2, plus a check that the ATT&CK matrix itself is current. Every check is self-guarded so a green is earned (watched to fail a vulnerable fixture), never assumed. Use when asked to security-audit the stack or a client repo, run an OWASP/Top-10 review, verify security posture, or run a controls/compliance or ATT&CK/ISO/SOC coverage check. Not for writing new security features or fixing one specific vulnerability — this verifies and reports findings; it does not remediate.
argument-hint: [--surface all|repo|infra|app] [--target <repo>] [--config <infra.config.json>]
allowed-tools: [Read, Bash, Grep]
user-invocable: true
---

# security-audit

LAYER 2a of the `audit` package — the agent-facing entry point, and the only one
that audits the **full cross-surface** target (repo + hosted infra + the running
app) in one pass, on demand. The CI gate (`ci/`) covers the source-reachable
subset (`--reachability static`: repo + app:static) at deploy; the scheduled
runner (`scheduled/`) covers infra on a timer. You cover everything — including
the **app:dynamic** OWASP probes — because only you can reach and adapt to live
infra and a deployed staging app.

## Surfaces and reachability

Each control declares a **surface** (where it lives) and a **reachability** (how
it is reached). Reachability is what the dispatcher keys on:

| Surface | Reachability | Reached how | Run by |
|---------|--------------|-------------|--------|
| `repo` | static | read the checkout (`--target`) | CI gate, agent |
| `app` | static | read the checkout (`--target`) — headers/deps/logging config | CI gate, agent |
| `app` | dynamic | probe a **deployed staging app** (`--config`) — IDOR, cookie flags | **agent only** |
| `infra` | dynamic | probe hosted services (`--config`) — n8n/Firecrawl/Resend + logging-config state | scheduled, agent |

`app:dynamic` is never run by the CI gate — CI has no running app to probe. Point
it at a deployed **staging** URL, never production, and never with prod secrets.

You **call** the deterministic checks in `checks/`. You never re-describe or
reimplement a check here — one check, one home (`checks/<control>.mjs`), three
callers. If a check needs to change, change the script, not this file.

## The discipline (non-negotiable — WORKING_METHOD)

- **Probe before designing (§6).** Capture real paths/endpoints before you audit
  — a manifest pointing at a path that moved yields a false `unknown` or a hollow
  `pass`. Confirm the target's real layout first.
- **"It passed" is the product (§7).** This package's entire worth is that it
  doesn't false-pass. A `pass` is only real when the check's negative control
  fired — the bad input was provably injected and provably caught. `_common.mjs`
  enforces this structurally (an unguarded pass is downgraded to `unknown`), but
  you must still **read the `negative_control` field of every pass** and distrust
  any green where `injected`/`fired` aren't both true.
- **`unknown` is not `pass`.** A check that couldn't reach its target, parse its
  source, or inject its bad input returns `unknown`. Report it as *unverified*,
  never as covered. **Do not** talk yourself into a pass to make a run look green.
- **A check that can't be made to fail isn't a check.** If you add a control and
  can't watch it fail a vulnerable fixture, mark it `none`, not `done`.

## How to run

The whole audit, cross-surface:

```sh
node <skill-dir>/run.mjs --surface all --target <repo> --config <infra.config.json>
```

- **Repo surface** (`rls`, `revoke`, `secret-leak`) needs only `--target <repo>`
  — point it at the checkout under audit.
- **Infra surface** (`ssrf`, `webhook-auth`, `dns-auth`, `matrix-freshness`)
  needs live endpoints. Supply them via `--config` (see
  `scheduled/infra.config.example.json`): argv uses `$ENV` tokens expanded from
  the environment, so **no secret is ever written into a file or echoed**. An
  infra check with no config entry returns `unknown` ("no live config"), not a
  silent pass.

Run a single control to investigate it:

```sh
node <skill-dir>/checks/rls.mjs --target <repo>          # judge a target
node <skill-dir>/checks/rls.mjs --self-test              # prove the detector still works
```

Each check prints one JSON line (the contract in `README.md`): `status` of
`pass`/`fail`/`unknown`, `evidence`, `negative_control`, and the `attack` /
`iso27001_2022` / `soc2_cc` citation pulled from `mapping/controls.json`.

## What each control audits

| Control | Surface · reach | OWASP | Audits | Live target |
|---------|-----------------|-------|--------|-------------|
| `rls` | repo · static | A01 | every app-data table enables row-level security | `packages/db` migrations |
| `revoke` | repo · static | A01 | PII tables revoke baseline grants from `anon`+`public` (the DEFECT-1 class) | `packages/db` migrations |
| `secret-leak` | repo · static | — | no committed secrets; `.env` is gitignored | tracked source files |
| `security-headers` | app · static | A05 | CSP/HSTS/X-Frame-Options/X-Content-Type-Options/Referrer-Policy configured | `apps/*/next.config.ts`, `vercel.json` |
| `dependency-audit` | app · static | A06 | dependency-CVE alerting configured (Dependabot / SCA) | `.github/dependabot.yml`, workflows |
| `app-logging` | app · static | A09 | security-event logging wired into auth paths | auth route/middleware source |
| `access-probe` | app · dynamic | A01 | IDOR: user A cannot read user B's record via the API | **deployed staging app** |
| `cookie-flags` | app · dynamic | A07 | session cookie sets HttpOnly + Secure + SameSite | **deployed staging app** |
| `ssrf` | infra · dynamic | A10 | the scrape path refuses internal/loopback/link-local targets | Firecrawl via n8n |
| `webhook-auth` | infra · dynamic | — | inbound webhooks reject unsigned/wrong-sig payloads (HMAC-SHA256) | n8n webhooks |
| `dns-auth` | infra · dynamic | — | sending domain has SPF + DKIM + DMARC | Resend domain (tessera-project.dev) |
| `supabase-logging` | infra · dynamic | A09 | auth/API logging + log drain enabled | Supabase mgmt API / state doc |
| `gh-secret-scanning` | infra · dynamic | — | secret scanning + push protection enabled | GitHub repo security settings |
| `device-signin-alerts` | infra · dynamic | — | Google + GitHub new-device sign-in alerts on | account-security settings |
| `vercel-observability` | infra · dynamic | — | observability + firewall configured | Vercel project settings |
| `alert-route` | infra · dynamic | A09 | a test event reaches the alert channel — **STUBBED (see below)** | notify/ seam (n8n pending) |
| `matrix-freshness` | infra · dynamic | — | the pinned ATT&CK version matches MITRE's current release | MITRE STIX feed |

The fixed manifests in `manifests/` define exactly what each check pulls — that
scope is not your discretion (WORKING_METHOD §1). Read a manifest to see a
control's real globs/endpoints/state-document shape and its live-target notes/traps.

### Reuse, not duplication — one check per boundary (WORKING_METHOD §5/D8)
- **A01 broken access control** is ONE boundary with two views: `rls`/`revoke`
  verify the migration policy (repo); `access-probe` exercises the same boundary
  through the running app (IDOR). `access-probe` does not re-implement RLS
  reasoning — policy correctness stays single-homed in `rls.mjs`.
- **A10 SSRF on app endpoints** reuses the existing `ssrf` check — point it at an
  app endpoint via `--config` `--target`; there is no second SSRF script.
- **A06** is satisfied by `dependency-audit` (it doubles as the "Dependabot
  enabled" logging-config row).

### The alert route is deliberately STUBBED
`alert-route` depends on a notification channel that does not exist yet — an n8n
workflow will be wired behind the `notify/` seam later. Against the stub it
reports **`unknown`** (an honest *unverified* — channel not wired), never a pass.
Do not let it flip to `done`/`pass` until you have watched a real test event
arrive. See `notify/README.md` for the seam contract. The n8n workflow that lands
behind it is **your hosted infrastructure**, never client-delivered code (baseline §8).

### Companion (non-mechanical) layer
This package builds only the *configuration* half of logging/detection — that the
controls are installed and enabled. The *practice* — reading alerts, triaging,
incident-response execution — is not mechanically checkable and lives in the
Incident-Response / Logging & Detection docs, not in `checks/`. A green here never
claims anyone is watching the alerts.

## Assembling the report

Collect the JSON results and present a **mapped coverage report**, not bare
red/green:

- One row per control: `status`, the ATT&CK ID(s), ISO clause(s), SOC CC(s), and
  the evidence line. The citations come straight from each result.
- Separate **findings** (`fail`) from **unverified** (`unknown`) — never merge
  them. State which surface each `unknown` couldn't reach and why (e.g. infra
  endpoint not configured, container DNS, egress blocked).
- Lead with the honest line: coverage means *which techniques were checked*, not
  that the stack is correct. A green run is not a certification or an attestation.

## When `matrix-freshness` reports drift

A `fail` from `matrix-freshness` means the bundled ATT&CK version (`mapping/
ATTACK_VERSION`) is behind MITRE's current release. **Surface what changed** — the
version gap and which technique IDs in `mapping/` were added/deprecated/renumbered
— and let the human decide whether any new technique is in scope for the six
services. **Do not auto-edit the mapping.** This is a maintenance prompt, not a
deploy blocker.

## Boundaries you audit but never cross

This package *audits* the recurring-service boundary (baseline §8) and the Shopify
data boundary (§8.1) — it **reports** a violation (an n8n workflow definition or a
competitor-pricing pipeline landing in a client repo, a table mirroring Shopify's
commercial state) as a finding. It never itself writes those things into a repo.
Auditing a boundary and crossing it are opposite acts.

## Files

(All in the same directory as this SKILL.md — the `audit/` package root.)

- `run.mjs` — the dispatcher you invoke; selects checks by surface, aggregates.
- `checks/` — the deterministic core; one self-guarding script per control.
- `manifests/` — fixed evidence manifests (what each check pulls).
- `mapping/` — `controls.json` (citations the checks read), `ATTACK_VERSION`
  (pinned release), `security-coverage-matrix.md` (human-readable matrix).
- `fixtures/` — the known-good/known-bad targets each check is proven against.
- `demo.mjs` — the demonstration/smoke-test: proves every check earns its verdict.
- `README.md` — the output contract, the surface split, and the traps.
