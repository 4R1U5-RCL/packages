---
name: config-hygiene
description: Tend a tree via a profile — the IOPHON ~/.claude config tree (claude), a git codebase (codebase), or an LLM-artifact store (llm-artifacts). Take a self-verified backup (archive created AND checked: stable sha256, extractable, tree fully captured) and/or detect drift; under the claude profile drift can be moved into place (human-gated), under codebase/llm-artifacts it is report-only. Every verdict is self-guarded so a green is earned (backup's sentinel negative control fires; cleanup is watched to flag a bad input), never assumed. Use when asked to back up ~/.claude or a repo, verify a backup, check/tidy config-tree organisation, report codebase junk, or find misplaced transcripts. NOT for editing content, managing secrets (see the audit package), or backing up a deployed app/database.
user-invocable: true
---

# config-hygiene

The agent-facing entry point of the `hygiene` package — the on-demand caller for
the studio's deterministic hygiene tooling, over a tree selected by `--profile`
(`claude` | `codebase` | `llm-artifacts`, default `claude`; `--target` overrides
the profile's default path). The **scheduled** runner (`scheduled/`) is the
primary unattended automation; the **CI** gate (`ci/`) is a narrow drift check.
You are the on-demand caller, and the only one that should ever run a **mutating**
action, because only you can carry the human confirmation those require.

**Profiles in one line:** `claude` = the §2 home layout, cleanup RELOCATES strays;
`codebase` = a git repo, cleanup REPORT-ONLY (git is the ignore authority; needs a
working tree); `llm-artifacts` = a transcript/cache store, cleanup REPORT-ONLY
(flags valuable artifacts stranded in a cache). Only `claude` cleanup may `--apply`.

You **call** the deterministic controls in `checks/`. You never re-describe or
reimplement a control here — one control, one home (`checks/<control>.mjs`), three
callers. If a control must change, change the script, not this file.

## The discipline (non-negotiable — WORKING_METHOD)

- **"It passed" is the product (§7).** A `pass` is only real when the control's
  negative control fired — backup's deliberately-incomplete archive was caught, or
  cleanup was watched to flag a stray. `_common.mjs` enforces this structurally (an
  unguarded pass is downgraded to `unknown`), but still **read the
  `negative_control` field** of every pass and distrust any green where
  `injected`/`fired` aren't both true.
- **`unknown` is not `pass`.** A control that couldn't scan its target, or whose
  tooling failed, returns `unknown`. Report it as *unverified*, never as done.
- **Dry-run is the default; mutation is human-gated.** Both `--apply` paths mutate
  a real tree (cleanup MOVES files; backup WRITES an archive). Never pass `--apply`
  without explicit human confirmation in this turn.
- **A backup is not a backup until it lives off-system.** When `backup --apply`
  succeeds it prints the off-system-copy reminder — relay it; do not let a verified
  local archive read as "safely backed up."

## How to run

Both controls, dry-run, over the home tree (claude profile, the default):

```sh
node <skill-dir>/run.mjs --target ~/.claude
```

Other profiles (note: their cleanup is report-only — see below):

```sh
node <skill-dir>/run.mjs --profile codebase --target /path/to/repo
node <skill-dir>/run.mjs --profile llm-artifacts --target ~/.claude/projects
```

Prove the detectors still work for a profile (no target needed):

```sh
node <skill-dir>/run.mjs --self-test --profile claude
node <skill-dir>/run.mjs --self-test --profile codebase
node <skill-dir>/run.mjs --self-test --profile llm-artifacts
```

### The mutating actions — only after explicit human confirm

```sh
# Write the real, re-verified archive into the profile's backup dir (then prints the
# off-system-copy reminder — the human-gated P2 step). Works for any profile:
node <skill-dir>/run.mjs --only backup --apply --target ~/.claude

# Move every stray to its canonical dir — claude profile ONLY (guarded: refuses to
# overwrite, verifies each landed). Show the dry-run drift report and get a yes FIRST:
node <skill-dir>/run.mjs --only cleanup --apply --target ~/.claude
```

`cleanup --apply` is **rejected** under `codebase`/`llm-artifacts` (report-only —
it returns `unknown` rather than mutate a codebase or artifact store). The correct
order is always: **dry-run → show the human what would change → on an explicit
yes, `--apply`.**

## What each control does

| Control | Profile | Does | Verdict basis |
|---------|---------|------|---------------|
| `backup` | any | archives the target (claude/llm: walk-minus-excludes; codebase: `git ls-files`), then self-verifies | `pass` only if the archive verifies (stable sha256, extractable, every in-scope file present) AND the sentinel negative control fired |
| `cleanup` | claude | strays vs the §2 layout; `--apply` MOVES them (guarded) | `pass` = 0 stray; `fail` = drift |
| `cleanup` | codebase | REPORT-ONLY: tracked or unignored junk (git is the ignore authority; needs a repo) | `pass` = clean; `fail` = committed/unignored junk |
| `cleanup` | llm-artifacts | REPORT-ONLY: a valuable artifact inside a regenerable cache | `pass` = none misplaced; `fail` = misplaced artifact |

The FIXED scope of each profile lives in `profiles/<name>.json` (cleanup mode +
rules; backup engine + roots/excludes) — not your discretion (WORKING_METHOD §1).
Read the active profile to see the exact rules.

## Assembling the report

- Lead with the backup verdict and, if applied, the archive path + sha256 + the
  **off-system reminder**.
- Report drift as a list of `from -> canonical-dest` moves; separate `fail`
  (drift) from `unknown` (could not scan). Never auto-apply moves — present them
  and let the human decide.

## Files

(All in the same directory as this SKILL.md — the `hygiene/` package root.)

- `run.mjs` — the dispatcher you invoke; runs the controls under a profile, aggregates.
- `checks/` — the deterministic core; one self-guarding script per control, plus
  `_common.mjs` (the contract) and `_fsutil.mjs` (walk / classify / tar+sha / git).
- `profiles/` — the FIXED scope per environment (claude / codebase / llm-artifacts).
- `manifests/_exclude.json` — the shared vendored/transient exclude set (claude profile).
- `fixtures/` — the known-good/known-bad trees each control is proven against.
- `demo.mjs` — the demonstration/smoke-test: proves both controls earn their verdicts.
- `ci/`, `scheduled/` — the gate and timer wrappers (thin; they call `run.mjs`).
- `README.md` — the output contract, the entry-point split, and the traps.
