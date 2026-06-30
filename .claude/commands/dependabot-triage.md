---
description: Triage and batch-merge open Dependabot PRs across the 4R1U5-RCL repos (green patch/minor only; majors held for review)
argument-hint: [<repo>] [--merge] [--dry-run]
allowed-tools: [Bash, Read]
---

Triage the open Dependabot PRs across the `4R1U5-RCL` repos (`studio`, `tessera`, `mosaic`, `packages`), group them by package and semver bump type, check CI, and either print a plan (`--dry-run`, the default) or batch-merge the green non-major ones (`--merge`). Majors and red-CI PRs are NEVER auto-merged — they are deferred for human review.

Uses the `gh` CLI (2.95.0 at `/usr/local/bin/gh`, authed via device flow in this container). All bash blocks begin with `set -euo pipefail` and quote every variable. `gh` exits non-zero when a list is empty; guard those calls with `|| true` so an empty result doesn't abort the run.

## Procedure

### 1. Parse arguments

- `<repo>` — a single bare repo name to scope to. Valid values: `studio`, `tessera`, `mosaic`, `packages`. If omitted, default the target set to **`studio` and `tessera`** (the repos with open Dependabot PRs; ~30 between them — react/typescript bumps under `apps/*` plus GitHub Actions bumps). Reject any repo name not in the four-repo list.
- `--merge` — perform merges of the green non-major PRs.
- `--dry-run` — print the triage plan only, merge nothing. **This is the default.** If neither `--merge` nor `--dry-run` is given, behave as `--dry-run`. If both are given, `--dry-run` wins (fail safe).

Set `MODE=dry-run` unless `--merge` is the sole mode flag.

### 2. List open Dependabot PRs per target repo

For each repo `R` in the target set:

```bash
set -euo pipefail
gh pr list -R "4R1U5-RCL/$R" --author "app/dependabot" --state open \
  --json number,title,labels,headRefName --limit 200 || true
```

- The dependabot bot author is `app/dependabot`.
- Empty list → record "no open Dependabot PRs" for that repo and move on.

### 3. Group by package and semver bump type

For each PR, derive:

- **Package** — from the title. Dependabot titles read `Bump <pkg> from <old> to <new>` (or `chore(deps): bump <pkg> …`). Extract `<pkg>`, `<old>`, `<new>`.
- **Bump type** — compare `<old>` vs `<new>` semver:
  - **major** — first version segment increases (e.g. `4.x → 5.0`). Also treat a `0.x → 0.y` minor as cautious: pre-1.0 minor bumps can be breaking, so flag `0.x` minor bumps as **review** too.
  - **minor** — middle segment increases, major unchanged.
  - **patch** — only the last segment increases.
  - If the version can't be parsed from the title, classify as **review** (don't guess green).
- Group the PRs: by package name, and within that by bump type. GitHub Actions bumps (paths under `.github/workflows`, title mentions `actions/*` or `dependabot` ecosystem `github-actions`) are grouped under an `actions` bucket but follow the same major/minor/patch rules.

### 4. Check CI status for each candidate

A PR is **merge-eligible** only if it is patch or minor (NOT major, NOT `0.x` minor) AND its checks are all green.

```bash
set -euo pipefail
# Exits non-zero if any check failed/pending; capture status without aborting.
gh pr checks "$PR_NUMBER" -R "4R1U5-RCL/$R" || true
```

- All checks `pass` → **green** (merge-eligible if also patch/minor).
- Any `fail`/`error` → **red** → defer (reason: "CI failing").
- Any `pending`/in-progress → **not yet green** → defer this run (reason: "CI pending"); it can be picked up on a later run.
- No checks configured at all → treat as **not green** and defer with reason "no CI signal" (don't merge blind).

### 5. Act on the plan

**`--dry-run` (default):** print the grouped triage plan and merge nothing. Show three sections:

- **Would auto-merge** — green patch/minor PRs: `#<num> <pkg> <old>→<new> (patch|minor) [repo]`.
- **Needs review** — every major bump (and `0.x` minor), each with reason "major bump — human review".
- **Red / blocked** — PRs with failing, pending, or absent CI, each with its reason.

**`--merge`:** for each merge-eligible (green patch/minor) PR:

```bash
set -euo pipefail
gh pr merge "$PR_NUMBER" -R "4R1U5-RCL/$R" --squash --auto || true
```

- `--squash --auto` merges once required checks pass (already green here) and keeps history clean. Pushing to a protected `main` is fine via the merge API; do NOT push branches directly.
- For each deferred PR (major, `0.x` minor, or red/pending/absent CI) leave a comment so the human reviewer sees why it was skipped:

```bash
set -euo pipefail
gh pr comment "$PR_NUMBER" -R "4R1U5-RCL/$R" \
  --body "Held by /dependabot-triage: <reason>. Not auto-merged — needs human review." || true
```

- NEVER call `gh pr merge` on a major bump, a `0.x` minor, or a non-green PR, regardless of mode.

### 6. Report back

```
Dependabot triage — <repos> — <MODE>

Merged:   <N>   (green patch/minor)
Deferred: <M>   (needs human review)

Deferred for review:
- #<num> <pkg> <old>→<new> [<repo>] — <reason>
...
```

In `--dry-run` the "Merged" line reads `0 (dry-run — would merge <N>)`. End with the next step: re-run with `--merge` to apply, or review the deferred majors manually.

## Constraints

- **Dry-run is the safe default.** Merging happens only when `--merge` is the explicit and sole mode flag.
- **Majors are never auto-merged** — neither are pre-1.0 (`0.x`) minor bumps. They are always deferred for human review.
- **Only green PRs merge.** Red, pending, or no-CI PRs are deferred, never merged.
- Only the four real repos are valid targets: `studio`, `tessera`, `mosaic`, `packages`. Default scope is `studio` + `tessera`.
- All bash uses `set -euo pipefail`, quotes variables, and guards empty/failed `gh` calls with `|| true`.
- Read-only except for the explicit `gh pr merge` / `gh pr comment` actions under `--merge`. Never edit repo files or push branches directly.

## Reference

- Repos: `4R1U5-RCL/{studio,tessera,mosaic,packages}` (see github-layout memory).
- Dependabot author handle: `app/dependabot`.
- `gh` auth: device flow in-container; token carries `workflow` scope. `main` is protected — merges go via the `gh pr merge` API, not direct pushes.
