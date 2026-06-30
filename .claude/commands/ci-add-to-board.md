---
description: Wire actions/add-to-project CI into a 4R1U5-RCL repo so new issues/PRs auto-add to its GitHub Projects board
argument-hint: <repo> [--board=<url>]
allowed-tools: [Read, Write, Bash]
---

Add the `actions/add-to-project` GitHub Actions workflow to a repo so every newly-opened issue and PR is auto-added to the right GitHub Projects v2 board. This is the route that actually works for `4R1U5-RCL` boards — the GitHub built-in "Auto-add to project" workflow is flaky for these User-level boards and never fires (don't retry it). This skill captures the copy-paste pattern already wired three times: `studio` (#6), `tessera` (#1/#2).

Ground facts (from the github-layout memory):

- Account `4R1U5-RCL` is a **personal User**, not an org. Repos: `studio`, `tessera`, `mosaic`, `packages`.
- Two **Projects v2 boards** (User-level, private):
  - **harness** → `https://github.com/users/4R1U5-RCL/projects/2`
  - **tessera** → `https://github.com/users/4R1U5-RCL/projects/1`
- Default mapping: `studio`, `mosaic`, `packages` → **harness (board 2)**; `tessera` → **tessera (board 1)**. Override with `--board=<url>`.
- The default `GITHUB_TOKEN` **cannot** write User-level Projects. A classic PAT with `project` scope is mandatory, referenced as the repo secret `ADD_TO_PROJECT_PAT`.

## Procedure

### 1. Resolve target repo + board URL

- `<repo>` is the first positional arg — a `4R1U5-RCL` repo name (`studio` | `tessera` | `mosaic` | `packages`).
- Board URL precedence:
  1. `--board=<url>` if passed (use verbatim).
  2. else `tessera` → `https://github.com/users/4R1U5-RCL/projects/1`.
  3. else (`studio`/`mosaic`/`packages`/other) → `https://github.com/users/4R1U5-RCL/projects/2`.
- Confirm `gh` is authed and has `workflow` scope (needed to push `.github/workflows/*`):
  ```bash
  set -euo pipefail
  gh auth status
  ```
  If auth is missing, run the device flow as a **backgrounded** Bash command and read the one-time code from the task output (a foreground `!` shell can swallow the code):
  ```bash
  gh auth login --hostname github.com --git-protocol https --web
  ```

### 2. Write `.github/workflows/add-to-project.yml`

Clone/checkout the repo, create a branch (never edit on `main`), and write this file verbatim, substituting only the `project-url` value:

```yaml
name: Add to project board

on:
  issues:
    types: [opened]
  pull_request:
    types: [opened]

jobs:
  add-to-project:
    name: Add issue/PR to project
    runs-on: ubuntu-latest
    steps:
      - uses: actions/add-to-project@v1.0.2
        with:
          project-url: https://github.com/users/4R1U5-RCL/projects/2
          github-token: ${{ secrets.ADD_TO_PROJECT_PAT }}
```

- Replace `project-url` with the board resolved in step 1 (`.../projects/1` for tessera).
- `actions/add-to-project@v1.0.2` is the pinned version confirmed live across the three existing wirings — keep it pinned, do not float to `@main`.
- Keep `github-token: ${{ secrets.ADD_TO_PROJECT_PAT }}` exactly — do NOT use `${{ secrets.GITHUB_TOKEN }}` (it cannot write User-level Projects).

### 3. Ensure the `ADD_TO_PROJECT_PAT` secret exists on the repo

The secret must be a **classic PAT with `project` scope** (User-level Projects v2 write). Check, and set if absent:

```bash
set -euo pipefail
gh secret list --repo "4R1U5-RCL/${REPO}" | grep -q ADD_TO_PROJECT_PAT \
  && echo "PAT secret present" \
  || echo "MISSING: set ADD_TO_PROJECT_PAT before the workflow can write"
```

To set it (paste the PAT when prompted; never echo the token into a command line):
```bash
gh secret set ADD_TO_PROJECT_PAT --repo "4R1U5-RCL/${REPO}"
```

Note: a fine-grained Projects-only PAT is the eventual target; the existing repos reuse a broad-scope token (flagged for rotation).

### 4. Commit on a branch + open a PR (never push to main)

Pushing to `main` is blocked by the harness auto-mode classifier — route through a branch + PR + merge:

```bash
set -euo pipefail
git checkout -b ci/add-to-project
git add .github/workflows/add-to-project.yml
git commit -m "ci: auto-add new issues/PRs to the project board"
git push -u origin ci/add-to-project
gh pr create --repo "4R1U5-RCL/${REPO}" \
  --title "ci: auto-add issues/PRs to project board" \
  --body "Wires actions/add-to-project@v1.0.2 so new issues and PRs auto-add to the board. Requires the ADD_TO_PROJECT_PAT secret (classic PAT, project scope)." \
  --base main
```

### 5. Verify the wiring fires

After the PR is merged (the workflow must be on the default branch to trigger), open a throwaway test issue and confirm it lands on the board:

```bash
set -euo pipefail
gh issue create --repo "4R1U5-RCL/${REPO}" \
  --title "test: add-to-project wiring" \
  --body "Throwaway issue to confirm board auto-add. Close after verifying."
# wait for the Action run, then check the run + the board
gh run list --repo "4R1U5-RCL/${REPO}" --workflow "add-to-project.yml" --limit 3
```

Confirm the issue appears on the target board (it should land in the `Todo` column — status option id `f75ad846`). Close the test issue once confirmed.

### 6. Report back

```
add-to-project wired: 4R1U5-RCL/<repo> → <board url>

PR: <pr link>
Secret: ADD_TO_PROJECT_PAT <present | set this run | MISSING — set before it works>
Verified: <yes — test issue #N landed on board | pending merge>
```

## Constraints

- Only ever write `.github/workflows/add-to-project.yml` in the target repo — nothing else.
- Pin `actions/add-to-project@v1.0.2`; on `issues: [opened]` and `pull_request: [opened]` only.
- Token is always `${{ secrets.ADD_TO_PROJECT_PAT }}` — the default `GITHUB_TOKEN` cannot write User-level Projects.
- Never push to `main`; always branch + PR.
- Never echo a PAT value into a command line; use interactive `gh secret set`.
- Default board: tessera → projects/1, everything else → projects/2; `--board` overrides.

## Reference

- github-layout memory: `~/.claude/projects/-studio/memory/project_studio-github-layout.md`
- harness board: `https://github.com/users/4R1U5-RCL/projects/2`
- tessera board: `https://github.com/users/4R1U5-RCL/projects/1`
- Status option ids: Todo `f75ad846`, In Progress `47fc9ee4`, Done `98236657`.
- Existing wirings: studio #6, tessera #1/#2.
