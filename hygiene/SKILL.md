---
name: config-hygiene
description: Tend the IOPHON ~/.claude config tree — take a self-verified backup (archive created AND checked: stable sha256, extractable, tree fully captured) and/or detect layout drift (stray files outside their canonical §2 subdir), with an optional human-gated move-into-place. Every verdict is self-guarded so a green is earned (backup's sentinel negative control fires; cleanup is watched to flag a stray), never assumed. Use when asked to back up ~/.claude, verify a backup, check/tidy config-tree organisation, or report drift. NOT for editing config content, managing secrets, or backing up a deployed app/database — this preserves and tidies a config tree; it does not change what is in it.
user-invocable: true
---

# config-hygiene

The agent-facing entry point of the `hygiene` package — the on-demand caller for
the studio's deterministic config-hygiene tooling over the IOPHON home tree
(default `~/.claude`, overridable with `--target`). The **scheduled** runner
(`scheduled/`) is the primary, unattended automation; the **CI** gate (`ci/`) is a
narrow drift check for a version-controlled config tree. You are the on-demand
one, and the only caller that should ever run a **mutating** action, because only
you can carry the human confirmation those require.

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

Both controls, dry-run, over the home tree:

```sh
node <skill-dir>/run.mjs --target ~/.claude
```

Run one control:

```sh
node <skill-dir>/run.mjs --only backup  --target ~/.claude     # dry-run: build + verify in temp
node <skill-dir>/run.mjs --only cleanup --target ~/.claude     # dry-run: drift report
```

Prove the detectors still work (no target needed):

```sh
node <skill-dir>/run.mjs --self-test
node <skill-dir>/checks/backup.mjs --self-test
node <skill-dir>/checks/cleanup.mjs --self-test
```

### The mutating actions — only after explicit human confirm

```sh
# Write the real, re-verified archive into <target>/data/backups/ (then prints the
# off-system-copy reminder — the human-gated P2 step):
node <skill-dir>/run.mjs --only backup --apply --target ~/.claude

# Move every stray file to its canonical dir (guarded: refuses to overwrite,
# verifies each landed). Show the dry-run drift report and get a yes FIRST:
node <skill-dir>/run.mjs --only cleanup --apply --target ~/.claude
```

The correct order is always: **dry-run → show the human what would change → on an
explicit yes, `--apply`.**

## What each control does

| Control | Surface | Does | Verdict basis |
|---------|---------|------|---------------|
| `backup` | local | archives the target tree, then self-verifies | `pass` only if the archive verifies (stable sha256, extractable, every in-scope file present) AND the sentinel negative control fired |
| `cleanup` | local | scans for stray files vs the canonical §2 layout | `pass` = 0 stray (tidy); `fail` = drift; `--apply` moves strays into place, guarded |

The FIXED scope of each control lives in `manifests/` (cleanup's canonical
directory rules; backup's include roots + excludes) — not your discretion
(WORKING_METHOD §1). Read a manifest to see the exact rules.

## Assembling the report

- Lead with the backup verdict and, if applied, the archive path + sha256 + the
  **off-system reminder**.
- Report drift as a list of `from -> canonical-dest` moves; separate `fail`
  (drift) from `unknown` (could not scan). Never auto-apply moves — present them
  and let the human decide.

## Files

(All in the same directory as this SKILL.md — the `hygiene/` package root.)

- `run.mjs` — the dispatcher you invoke; discovers controls, runs them, aggregates.
- `checks/` — the deterministic core; one self-guarding script per control, plus
  `_common.mjs` (the contract) and `_fsutil.mjs` (walk / classify / tar+sha).
- `manifests/` — the FIXED scope of each control (cleanup rules; backup roots/excludes).
- `fixtures/` — the known-good/known-bad trees each control is proven against.
- `demo.mjs` — the demonstration/smoke-test: proves both controls earn their verdicts.
- `ci/`, `scheduled/` — the gate and timer wrappers (thin; they call `run.mjs`).
- `README.md` — the output contract, the entry-point split, and the traps.
