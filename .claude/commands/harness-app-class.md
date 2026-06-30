---
description: Scaffold a new harness app-class in /studio and wire every registration point (config → planner → generator → evaluator → verify → deploy) so the pipeline recognizes it. Covers BOTH shapes — Track A studio-ops template class (n8n-template/supabase-template) and Track B served-app class (research/webApp).
argument-hint: <app-class-name> [--track=A|B] [--flag=<camelCaseFlag>] [--kind=<snake_case_kind>] [--no-package]
allowed-tools: [Read, Write, Edit, Bash, Agent, Grep]
---

Add a new **app-class** to the /studio harness. An app-class is a structural build
shape the planner → generator → evaluator → verify → deploy pipeline recognizes via
a tier feature flag. This skill scaffolds the files and wires the registration points.

> **This extends the harness itself — it is the sanctioned way to close a template
> gap (CLAUDE.md §1.6 "config, not code"), NOT a per-client hand-edit.** Always
> work on a branch; the result goes through review before merge.

## There are TWO app-class shapes — pick the right track FIRST

| | **Track A — studio-ops template class** | **Track B — served-app class** |
|---|---|---|
| Examples | `n8n-template`, `supabase-template` | `research`, `webApp` |
| What it builds | a FIXED primitive library, provisioned to a hosted control plane (n8n cloud, Supabase) | a custom Next app at `apps/<name>/` that ships to Vercel |
| Hard-spec kind | new `<kind>` (e.g. `n8n_workflow`), emits **no** page items | emits `page` items from a route-set constant |
| Paired package | YES — `@studio/<name>-templates` | NO |
| Generator | custom `build<AppClass>Prompt` branch | the **default** generator prompt path (no custom branch) |
| Manifests | new `finalPassOnly` boundary checks | none new (uses `page` items + `design-scope`) |
| `verify-<name>.ts` | YES — canary provision/teardown | NO — handled by the served-app defer path |
| Deploy | `realProvision<AppClass>s` to control plane | folded into `shipsToVercel` |
| `test:<name>` script | YES | NO — coverage lives in `test:harness`/`test:verify`/`test:deploy` |

If `--track` isn't given, infer: does the class ship a hosted-service template (A) or
a user-facing app (B)? Confirm the track with the user before editing — picking wrong
means scaffolding the wrong half-dozen files.

## Inputs & naming derivation

`$ARGUMENTS[0]` is `<app-class-name>` (kebab-case). If absent, ask. Derive the rest
unless overridden by a flag. **Worked example below uses `report-template` (a NEW
Track-A name) — do NOT reuse `research`/`webApp`/`n8n-template`/`supabase-template`;
those already exist and will collide.**

| Token | Convention | Track-A example (`report-template`) |
|---|---|---|
| `<app-class-name>` | kebab; add-on + verify-stage name | `report-template` |
| `<flag>` | camelCase feature flag (`--flag`) | `reportTemplate` |
| `<kind>` | snake_case hard-spec kind, Track A only (`--kind`) | `report_template` |
| `<specs>` | client manifest array (camel, plural) | `reportTemplates` |
| `<SpecType>` | PascalCase element type | `ReportTemplateSpec` |
| `<builderDir>` | builder dir in the build-target repo | `reports/` |
| `<AppClass>` | PascalCase for symbols | `ReportTemplate` |
| `<name>-templates` | paired package (Track A only) | `report-templates` |

Confirm the derived token table with the user before editing.

### 0. Branch + PREFLIGHT (do this before ANY edit)
```
cd /studio
git checkout -b harness/<app-class-name>-app-class
```
**Existence check — STOP if the class already exists.** A duplicate flag/add-on
causes duplicate-field / duplicate-key compile errors and a contradictory second
hard-spec branch:
```
grep -n "<flag>" config/types.ts config/tier-defaults.ts
grep -n "'<app-class-name>'" config/tier-defaults.ts
ls packages/<name>-templates apps/<app-class-name> harness/stages/verify-<app-class-name>.ts 2>/dev/null
```
If the flag, add-on, package, or app dir already exists → the class is likely already
built. STOP and report it as already-present rather than scaffolding duplicates.

Then read the precedent commits/files for your track and copy house style exactly —
do NOT work from this checklist alone:
- **Track A:** `git show 03cb231` (n8n-template) and `git show 500edd4` (supabase-template).
- **Track B:** read the live `research` + `webApp` wiring — `config/types.ts` (`researchApp`/`webApp` flags), the `researchApp` branch + `RESEARCH_PAGES` in `harness/compile-hard-spec.ts`, `shipsToVercel` in `harness/stages/deploy.ts`, the `deferBrandWiring`/`opsClassLabel` served-app path in `harness/stages/verify.ts`, and the research/webApp cases in `harness.test.ts`/`deploy.test.ts`/`verify.test.ts`.

---

## TRACK A — studio-ops template class

### A1. Config — `config/`
- **`config/types.ts`**: `<flag>: boolean;` in `FeatureFlags` (doc-comment STRUCTURAL); `<specs>?: <SpecType>[];` in `ClientConfig`; `export interface <SpecType>` with exactly `key: string`, `name: string`, `expect: string`.
- **`config/tier-defaults.ts`**: `<flag>: false,` in **all 3** `TIER_BASE` blocks; `| '<app-class-name>'` to the `AddOn` union; `'<app-class-name>': { <flag>: true, …companion rails }` to `ADDON_FLAGS` (add companion rails only if templates speak another contract, e.g. n8n-template flips `n8n: true`).

### A2. Planner — `harness/compile-hard-spec.ts`
- `| '<kind>'` to the `HardSpecItem.kind` union.
- `else if (cfg.tier.features.<flag>) { … }` branch in `compileHardSpec` (before `webApp`): emit NO page items; loop `cfg.client.<specs> ?? []` pushing `{ kind: '<kind>', key, expect }`.
- Add `feature === '<flag>'` to the feature-items skip-list guard.

### A3. Generator — `harness/stages/generator.ts`
- Add `build<AppClass>Prompt(ctx, spec)` (model on `buildN8nTemplatePrompt`): filter by `kind === '<kind>'`, list `<builderDir>/<key>.ts — <expect>`, state the rules (compose ONLY from `@studio/<name>-templates/primitives`, single `build(params)` export, no literal secrets, boundary laws) + self-check.
- In `generator(ctx)`, after `readHardSpec`: `if (ctx.config.tier.features.<flag>) return invokeClaudeBuild(ctx, build<AppClass>Prompt(ctx, spec));` before the default path. Reuse `invokeClaudeBuild`.

### A4. Evaluator manifests — `harness/manifests/index.ts`
- Add checks to `MANIFESTS`, each `patterns: ['<builderDir>/**/*.{ts,js}']` + **`finalPassOnly: true`**. Trio: `<app-class-name>-secrets` (escalate), `<app-class-name>-boundary` (§8/§8.1, escalate), domain check (`-rls`/`-guards`, reloop).
- Phrase `judgeQuestion`s to PASS on no-violation/empty evidence; do NOT set `runOnEmptyEvidence: true`.
- Add `'<builderDir>/**/*.{ts,js}'` to the `design-scope` manifest's `patterns`.

### A5. Verify — NEW `harness/stages/verify-<app-class-name>.ts`
Model on `verify-n8n-template.ts`. Export `verify<AppClass>(ctx)`, `resolve<AppClass>Plan(ctx)`, `run<AppClass>VerifyCheck(plan, deps)` (provision each template to a THROWAWAY canary, introspect, tear down; DEFER when flag off / creds absent / no templates; violation → `fail`; transport gap → `defer`), and a `loadBuilder…` helper reused by deploy.
- **`harness/stages/verify.ts`**: `import { verify<AppClass> }`; `const <flag>Class = features?.<flag> === true;`; fold into `templateOpsClass` (`… || <flag>Class`) + extend `opsClassLabel`; `const <appClass>Outcome = await verify<AppClass>(ctx);` pushed to `allOutcomes`; update summary log.

### A6. Deploy — `harness/stages/deploy.ts`
- `DeployPlan`: `<flag>?`, `<specs>?: Array<{key;name}>`, `<flag>Configured?`. `DeployDeps`: `provision<AppClass>s?`.
- `runDeploy`: early branch (precedence) honoring `<flag>Configured`, `safeStep` → `provision<AppClass>s`, fail → `{kind:'build_error'}`.
- `export async function realProvision<AppClass>s(plan)`: env creds absent → `skipped`; loop `<specs>`, dynamic-import `<builderDir>/<key>.ts` via `pathToFileURL`, `build(params)`, import FROZEN `@studio/<name>-templates/provision` (hoist once), provision idempotent/dormant.
- `resolvePlan(ctx)`: compute the three plan fields. `deploy(ctx)`: add `provision<AppClass>s: realProvision<AppClass>s` dep. Document new env vars in the header comment (env only).

### A7. Package — `packages/<name>-templates/` (skip with `--no-package`)
Studio-ops, never ships to a client. `package.json` (`@studio/<name>-templates`, private, `type:module`, exports `./primitives`+`./provision`, `tsx` test); `src/primitives.ts` (FIXED builders + `assemble…` + `…Def` type); `src/provision.ts` (idempotent provisioner + teardown + `ProvisionContext`/`Options`/`Result`); `src/primitives.test.ts`; `CLAUDE.md` (hard-constraints: never-ships, why not a §8 violation).

### A8. Root wiring + tests
- `package.json`: `"@studio/<name>-templates": "workspace:*"` dep; `"test:<app-class-name>": "tsx harness/verify-<app-class-name>.test.ts"` + splice into the aggregate `test`.
- `tsconfig.packages.json`: add `"packages/<name>-templates/src"` to `include`.
- NEW `harness/verify-<app-class-name>.test.ts` (stub deps: canary pass / violation→fail / creds-absent→defer).
- Don't edit `pnpm-workspace.yaml`; don't hand-edit `pnpm-lock.yaml`.

**Track-A invariant checklist:** `config/types.ts` · `config/tier-defaults.ts` (3× TIER_BASE + AddOn + ADDON_FLAGS) · `compile-hard-spec.ts` · `generator.ts` · `manifests/index.ts` (+design-scope) · **NEW** `verify-<name>.ts` · `verify.ts` · `deploy.ts` · **NEW** `packages/<name>-templates/*` · `package.json` · `tsconfig.packages.json` · **NEW** `verify-<name>.test.ts` · lockfile via install.

---

## TRACK B — served-app class

A served-app class builds a custom Next app and ships it to Vercel. It uses the
default generator path and the served-app verify/deploy machinery — **NO** template
package, **NO** `<kind>`/manifests/`verify-<name>.ts`/`test:<name>`/provisioner.

### B1. Config — `config/`
- **`config/types.ts`**: `<flag>App: boolean;` in `FeatureFlags` (doc-comment STRUCTURAL, like `researchApp`/`webApp`). No `<SpecType>` — served apps don't take a template manifest.
- **`config/tier-defaults.ts`**: `<flag>App: false,` in **all 3** `TIER_BASE` blocks; `| '<app-class-name>'` to `AddOn`; `'<app-class-name>': { <flag>App: true, …companion rails }` to `ADDON_FLAGS` (companion rails as the app needs, e.g. `research` flips `documentStore: true, firecrawlScraping: true`).

### B2. Planner — `harness/compile-hard-spec.ts`
- Define the route-set constant (model on `RESEARCH_PAGES`): `const <NAME>_PAGES = [{ route, …expectations }, …]`.
- Add `else if (cfg.tier.features.<flag>App) { … }` branch emitting one `page` hard-spec item per route in `<NAME>_PAGES`.
- Add `feature === '<flag>App'` to the feature-items skip-list guard.

### B3. Generator
- **No custom branch.** Served apps go through the default storefront/page generator prompt path — confirm the default path already handles `page` items (it does for `research`/`webApp`). Add a branch only if the app needs genuinely different prompt instructions.

### B4. Verify — `harness/stages/verify.ts`
- Fold the class into the served-app path: extend the `deferBrandWiring` / served-app branch so brand-wiring + storefront/shopify-rail layers behave correctly, and extend `opsClassLabel`. No new `verify-<name>.ts`.

### B5. Deploy — `harness/stages/deploy.ts`
- Fold into `shipsToVercel` so the app deploys to Vercel like `research`/`webApp`. No `realProvision…`.

### B6. Tests
- Add cases mirroring the existing `research`/`webApp` coverage: add-on resolution + scaffold-override in `harness.test.ts`, "→ ships to VERCEL" in `deploy.test.ts`, served-app defer in `verify.test.ts`. No `test:<name>` script.

**Track-B invariant checklist:** `config/types.ts` · `config/tier-defaults.ts` (3× TIER_BASE + AddOn + ADDON_FLAGS) · `compile-hard-spec.ts` (route-set constant + page branch + skip-guard) · `verify.ts` (served-app path) · `deploy.ts` (`shipsToVercel`) · test cases in `harness.test.ts`/`deploy.test.ts`/`verify.test.ts`. NO package, NO manifests, NO `verify-<name>.ts`, NO `test:<name>`.

---

## Install, typecheck, verify recognition (both tracks)
```
cd /studio
pnpm install
pnpm typecheck && pnpm typecheck:packages
pnpm test:harness && pnpm test:verify && pnpm test:deploy   # both tracks
pnpm test:<app-class-name>                                   # Track A only (script exists)
pnpm --filter @studio/<name>-templates test                 # Track A only
```
End-to-end (a client opting in via `tier.config.ts` add-on `['<app-class-name>']`):
```
pnpm new-client --config ./config --out ./clients/<slug>
npx tsx harness/run.ts --client ./clients/<slug>
```
Recognition: Track A — planner emits `<kind>` items, generator logs the build, verify shows studio-ops defers + the `<name>` canary, deploy provisions N (or honest skip). Track B — planner emits `page` items, generator builds `apps/<name>`, verify runs served-app layers, deploy ships to Vercel.

## NEVER edit (app-class-agnostic)
`harness/run.ts`, `harness/orchestrator.ts`, `harness/evaluator.ts`,
`harness/stages/planner.ts`, `harness/stages/detect-production.ts`,
`pnpm-workspace.yaml`, `scripts/new-client.ts`.

## Close-out
Report the full file list changed, the typecheck/test results verbatim (pass/fail —
never claim green you didn't see), and leave the branch for human review at the back
gate. **If the preflight shows the class already exists, or any step reveals the
recipe no longer matches the repo (precedents moved), STOP and surface it as a
finding rather than forcing the edit.** That escape hatch is load-bearing — it is
what keeps a wrong-track or duplicate scaffold from corrupting the harness.
