# hygiene — self-verifying backup + drift detection across three environments

A self-contained, reusable package that **tends** a tree — the IOPHON home config
tree, a source codebase, or an LLM-artifact store — via a chosen **profile**
(`--profile`, default `claude`). It folds two operator skills into hardened,
self-guarded units:

- **`backup`** — a PRESERVATION action that self-verifies: it creates a `.tar.gz`
  (+ sha256 + a manifest of entries) and only declares `pass` when the archive was
  created *and verified* — its sha256 is stable on re-read, it is extractable, and
  every in-scope file is present in the listing (proving it captured the tree, not
  an empty/partial tar).
- **`cleanup`** — a DRIFT DETECTOR. Under the `claude` profile it scans for stray
  files that violate the canonical §2 layout and can RELOCATE them (`--apply`).
  Under the `codebase` and `llm-artifacts` profiles it is **report-only** — it
  flags drift but never moves or deletes. `pass` = clean, `fail` = drift,
  `unknown` = couldn't scan.

It lives in the reusable-packages monorepo (`4R1U5-RCL/packages`) at `hygiene/`
and is **consumed by pulling a pinned version**, never copy-forked into a host
(a copy-and-fork would recreate exactly the drift this kind of package exists to
prevent).

> **The one caveat to carry into every run.** A `pass` means the *action* held —
> the archive verified, or the tree is clean by the active profile's rules. It does
> **not** mean your data is safe or your config is correct. A backup that verifies
> locally is still not a backup until a copy lives **off this host** (the
> human-gated P2 step the tool reminds you about but cannot perform). And cleanup
> only knows the drift each profile defines — it does not judge contents. Every
> `pass` here is *earned* (watched to fail a deliberately-bad input), never assumed.

---

## Architecture — one package, two controls, three profiles

```
hygiene/
├── checks/                 the deterministic core (single source of truth)
│   ├── _common.mjs           the ONE output contract + the structural honest-pass rule
│   ├── _fsutil.mjs           shared fs helpers: walk/classify a tree, tar+gzip (spawns
│   │                         system `tar`), sha256, archive verify, sentinel injection,
│   │                         guarded move, git helpers (codebase profile)
│   ├── cleanup.mjs           CONTROL: drift detector — dispatches on profile.cleanup.mode
│   │                         (relocate | git-junk | artifact-placement)
│   └── backup.mjs            CONTROL: create + self-verify an archive — dispatches on
│                             profile.backup.engine (exclude | git)
├── profiles/               the FIXED scope per ENVIRONMENT (not model discretion)
│   ├── claude.json           ~/.claude §2 layout — cleanup RELOCATES (the only mutating mode)
│   ├── codebase.json         a git working tree — cleanup REPORT-ONLY; git is the ignore authority
│   └── llm-artifacts.json    a transcript/output/cache store — cleanup REPORT-ONLY
├── manifests/
│   └── _exclude.json         the shared vendored/transient exclude set (claude profile)
├── fixtures/               a known-GOOD and known-BAD tree per profile
│   ├── cleanup/{good,bad}             claude: tidy vs. stray files
│   ├── codebase/{good,bad}            committed/unignored junk vs. correctly-ignored junk
│   ├── llm-artifacts/{good,bad}       artifacts well-placed vs. a transcript inside a cache
│   └── backup/tree                    the claude backup self-test tree
├── run.mjs                 the dispatcher: --profile / --target / --only, aggregate, exit codes
├── SKILL.md                agent entry point (on-demand; the only mutating caller)
├── ci/                     CI drift gate (a weak fit — see ci/README.md)
├── scheduled/              the STRONG automation: timer that backs up + reports drift
├── demo.mjs                the smoke-test: proves both controls earn their verdicts × all profiles
└── README.md
```

**The cardinal rule:** each control's logic is a script in `checks/` exactly once;
a profile only swaps the *scope and semantics*, never the logic's home. All three
entry points **call** the control; none re-describes it. One control, one home,
three callers — now over three profiles.

---

## Profiles

`--profile <name>` (default `claude`) selects the environment. The default
`--target` comes from the profile; override with `--target`.

| Profile | Target | `cleanup` | `backup` |
|---------|--------|-----------|----------|
| **`claude`** | `~/.claude` | **relocate** — strays → canonical §2 home; `--apply` moves (guarded) | whole tree minus the shared vendored/cache exclude set |
| **`codebase`** | a git repo | **report-only** — flags TRACKED junk or junk that's present-and-not-gitignored; correctly-ignored junk is expected, not drift | exactly `git ls-files --cached --others --exclude-standard` (tracked + untracked-not-ignored), fed to `tar -T` |
| **`llm-artifacts`** | `~/.claude/projects` | **report-only** — flags a valuable artifact (transcript/output) sitting inside a regenerable cache dir | valuable artifacts only; regenerable caches excluded |

**Why `claude` alone relocates.** It is the only environment with a canonical
"one home per file kind" layout, so a stray *has* a correct destination. A codebase
or artifact store has no such canonical home — inferring one and moving files would
be destructive — so cleanup there is strictly **detect-and-report** (it never
mutates). This asymmetry is deliberate, not an unfinished feature.

**Why the `codebase` profile delegates to git.** Ignore resolution is done by git
itself (`git ls-files` / `--exclude-standard`), not a hand-rolled `.gitignore`
parser — git is the authority, so `.gitignore` (negation, anchoring, nested
ignores) is honoured exactly and the backup set == the archive by construction.
Same reasoning by which this package spawns GNU `tar` instead of encoding tar
itself: don't reimplement fragile parsing a trustworthy local tool already nails.
Consequence: the `codebase` profile **requires a git working tree** — a non-repo
target returns `unknown`, never a false pass. Nested repos/worktrees git lists as
opaque directories are skipped (counted as `nested_skipped`), not folded in.

### The three entry points and why there are three

| Entry point | What it runs | Why it exists |
|-------------|--------------|---------------|
| `scheduled/` (timer) | `backup --apply` + `cleanup` drift report, over the live `~/.claude` | **The strong fit.** The thing hygiene is *for*: an unattended, verified backup on a schedule, plus a drift report a human acts on. |
| `SKILL.md` (agent) | either control, on demand; the only **mutating** caller | A human is in the loop, so it is the only caller allowed to run `--apply` (move files / write the archive) — those need a confirmation a timer/gate can't give. |
| `ci/` (gate) | `cleanup` in CHECK mode (dry-run) | **The weak fit, scoped honestly.** Only meaningful when the config tree is itself git-tracked. `backup` is deliberately absent — a stateless CI runner is the wrong place to archive a host's home tree. See `ci/README.md`. |

Unlike audit (whose three layers split a security surface evenly), hygiene's
layers are **deliberately lopsided**: the scheduled runner carries the weight, the
agent run adds the human-gated mutations, and the CI gate is a minor extra. We do
not pad the CI layer to look symmetrical — that would overstate it.

---

## The surface

There is exactly one surface: **`local`** — a config tree on the host. hygiene has
no `repo` or `infra` surface; it tends a home directory, not a deployed stack.
Naming the surface honestly keeps the contract from implying coverage it lacks.

---

## The output contract (read this before trusting a result)

Every control emits a single JSON object through `checks/_common.mjs`. There is
exactly one definition of a result and one definition of the honest-pass rule.

```json
{
  "control": "backup",
  "title": "self-verifying config-tree backup",
  "surface": "local",
  "status": "pass | fail | unknown",
  "evidence": "...",
  "message": "...",
  "negative_control": { "injected": true, "fired": true, "note": "..." },
  "details": { "...": "control-specific payload (stray list / archive sha256 / entries)" }
}
```

**Status vocabulary — only three:**

- **`pass`** — the action held *and* its negative control fired (the bad input was
  provably injected and provably caught). Exit code `0`.
- **`fail`** — a real finding: drift detected, or an archive that did not verify.
  Exit code `1`.
- **`unknown`** — could not determine: target unreadable/empty, the bad input
  could not be injected, tar/sha tooling failed. **Never a silent pass.** Exit `2`.

**The honest-pass rule is enforced structurally, not by convention.**
`_common.mjs` downgrades any `pass` whose negative control did not fire to
`unknown`. A control physically cannot emit a green it did not earn.

- **cleanup's negative control:** a stray file in `fixtures/cleanup/bad` the
  detector must flag (and the `good` fixture guards against a detector that flags
  everything).
- **backup's negative control:** an archive that DELIBERATELY OMITS a known
  sentinel file — the verifier must catch the miss ("an archive that misses a
  known file is caught"). The sentinel is injected only into a temp staging copy,
  **never the real target**.

---

## Invocation

Each control runs standalone (default `--profile claude`):

```sh
node checks/cleanup.mjs --target /path/to/tree          # dry-run drift report (claude)
node checks/cleanup.mjs --target ~/.claude --apply      # MOVE stray files (claude only, guarded)
node checks/cleanup.mjs --profile codebase --target /repo        # report-only drift
node checks/cleanup.mjs --profile llm-artifacts --target ~/.claude/projects
node checks/cleanup.mjs --self-test --profile codebase  # prove the detector works

node checks/backup.mjs  --target /path/to/tree          # dry-run: build + verify in temp
node checks/backup.mjs  --profile codebase --target /repo --apply   # gitignore-aware archive
node checks/backup.mjs  --self-test --profile llm-artifacts
```

The dispatcher runs both and aggregates:

```sh
node run.mjs --target ~/.claude                          # both, claude profile, dry-run
node run.mjs --profile codebase --target /path/to/repo   # codebase profile
node run.mjs --only backup --apply --target ~/.claude
node run.mjs --self-test --profile llm-artifacts         # every control's negative control
```

> `--apply` on `cleanup` is accepted only by the `claude` profile (the relocating
> one). For `codebase`/`llm-artifacts`, `--apply` is **rejected** with an `unknown`
> result — those profiles are report-only and never mutate the target.

---

## Traps (read before believing a result)

- **A local archive reads as "backed up."** It is not. `backup --apply` writes and
  re-verifies an archive *on this host*; until a copy is off-system, a host failure
  takes the backup with it. The tool prints the P2 reminder — it cannot perform it.
- **A tar that quietly captured nothing.** An empty or partial archive can still be
  a valid `.tar.gz`. That is why verification asserts *every in-scope file is
  present* and why the self-test's negative control is a sentinel-miss — a green
  here means the tree was actually captured, not just that tar exited 0.
- **A `pass` from a tree with nothing in it.** `cleanup` on a tree where no file
  matches any rule returns `unknown` (nothing to judge), never `pass` — a tidy
  verdict requires at least one file correctly in place. `backup` on an empty
  in-scope tree returns `unknown`, not a green for archiving nothing.
- **`--apply` is mutation.** cleanup moves files; backup writes into the tree. Both
  are dry-run by default and the moves are guarded (refuse to overwrite, verify the
  landing), but a careless `--apply` still changes a real home tree. The scheduled
  runner deliberately does NOT auto-move files.
- **Rules are scope, not omniscience.** Each profile's manifest is the FIXED set of
  kinds it knows. A file of an *unknown* kind is not drift — it is out of scope,
  reported as neither stray nor in-place. Extend scope by editing the profile.
- **report-only is weaker than relocate — on purpose.** The `codebase` and
  `llm-artifacts` profiles only *report* drift; they never fix it. That is a safety
  choice (no canonical home to move to), not an oversight — acting on a finding is
  the operator's call. Do not read a `codebase` `fail` as "hygiene will tidy it."
- **The `codebase` profile needs a git working tree.** It delegates ignore
  resolution to git; pointed at a non-repo it returns `unknown` (honest), never a
  pass. Secret detection deliberately OVERLAPS `audit/secret-leak` and is **not**
  reimplemented here — use the audit package for committed-secret findings.
- **`llm-artifacts` cleanup must look *inside* caches.** Unlike the claude profile
  (which excludes `cache`/`plugins`), this profile deliberately scans cache dirs —
  that is the only way to catch a valuable transcript that landed in one. Its
  `backup`, conversely, excludes those caches.
- **The tree has vendored / transient regions hygiene does NOT touch.** One shared
  exclude set (`manifests/_exclude.json`) is read by BOTH controls and applied
  *identically* to every walk **and** to `tar --exclude=`. It prunes
  `.git`, `node_modules`, `.pnpm-store`, `.next`, `plugins` (the plugin cache —
  its bundled `SKILL.md`/`*.md` are plugin payload, **not** misplaced IOPHON
  docs), `projects` (multi-GB conversation JSONL histories), and `cache`. Each is
  transient/regenerable or not IOPHON-managed. Excluding them is what keeps
  `cleanup` from false-flagging 2,585 plugin-cache files as strays, and what makes
  `backup`'s expected-file walk agree with the archive (the equality the verifier
  needs). Matching mirrors GNU tar's default *unanchored* exclude (a bare name
  matches that directory at any depth and prunes its whole subtree), so the walk
  and the archive see the identical set.

---

## Credential handling

There is none to handle — and that is worth stating. hygiene reads **no secrets**:
it needs only a path. Its config files carry no credentials, the archive excludes
`.env*` by manifest, and fixtures use obviously-fake placeholders only. (This is
the honest contrast with audit's scheduled runner, which exists *because* it holds
infra creds.)

---

## How this package is consumed

The harness and host **pull a pinned version** of this repo and reference
`hygiene/` in place. They do not hold an editable second copy. One source of truth,
versioned, pulled where needed. Pin to a tag; bump the pin deliberately.

---

## Scope boundary

- **In scope:** the package — `checks/` (two self-guarding controls + the contract
  and fs helpers), `fixtures/` proving each catches a known-bad input, `manifests/`
  (the FIXED rules/roots), `SKILL.md`, the `scheduled/` runner (the strong layer),
  the `ci/` drift gate (the weak layer, scoped honestly) — plus `demo.mjs`.
- **Out of scope (named, not silently skipped):** the **off-system copy** of a
  backup (a human step the tool reminds about), the **contents** of config files
  (hygiene tidies the layout and preserves the bytes; it does not judge what's in
  them), and backing up a **deployed app or database** (this is a config-tree tool,
  not a database backup tool).
- **The honest line:** a green run means the archive verified or the tree is tidy
  by these rules — not that your data is safe or your config is correct.

---

## Honest accounting

**Built and verified** (watched to fail a deliberately-bad input; negative control
fired). Both controls, the single output contract with its structural honest-pass
rule, the FIXED manifests, the dispatcher (`--only`, `--target`, `--self-test`),
and the entry-point wrappers. **Fully self-verified against bundled fixtures:**
cleanup's drift detection (catches the stray in `fixtures/cleanup/bad`, passes
`good`, and the guarded `--apply` mover tidies a temp copy to zero stray) and
backup's create-and-verify (archives the fixture tree, verifies sha256-stability +
extractability + complete capture, and the sentinel-miss negative control fires).
`demo.mjs` proves both controls earn their verdicts and exits non-zero if either
stops being able to fail its bad input.

**Verified against the real `~/.claude` tree (~122k files), not just fixtures.**
A smoke test against the actual home tree — `plugins/cache/**`, nested `.git`
repos, `node_modules`, multi-GB `projects/` histories — initially exposed two
real-environment bugs, now fixed and re-verified:

- **Scope.** `cleanup` had flagged 2,585 `plugins/cache/**/SKILL.md` files as
  stray skills, and `backup`'s expected-file walk counted 122,693 files while tar
  archived only 8,815 (the walk's matcher didn't prune nested `.git`/`node_modules`
  the way tar does). Fixed with the one shared exclude set above, applied
  identically to walk and tar. After the fix, on the live tree:
  `cleanup` → **0 stray** (159 in place, 0 plugin-cache false positives);
  `backup` dry-run → **pass**, `expected_files == archive_entries` (2054 == 2054),
  sha256 stable, extractable, `missing: []`. A `--apply` into a temp tree wrote
  and re-verified a real archive (expected == archived, sha matches the written
  `.sha256`, extracts clean, vendored dirs absent), and `cleanup` then classifies
  the produced `backup_*.tar.gz` as in-place.
- **Buffering.** `run.mjs` (and the scheduled wrapper, and the `tar` spawns in
  `_fsutil`) spawned children with the 1 MB `spawnSync` default; a real
  `cleanup` line was ~935 KB and one larger tree overflowed → unparseable output
  → a false `unknown`. Raised to 64 MB, and `cleanup`'s inline evidence list is
  now capped at the first 50 examples (`(+N more)`), with the full list/count kept
  in `details.stray`.

**The two new profiles, verified against real targets (not just fixtures).**

- **`codebase` against the live `/studio` repo (~14k files walked).** `cleanup`
  → **pass**, 0 committed/unignored junk (read-only — it changed nothing in
  `/studio`). `backup` dry-run → **pass**, `expected_files == archive_entries`
  (146 == 146), `missing: []`, with 4 nested git worktrees correctly skipped
  (`nested_skipped: 4`) rather than mis-counted — the bug a naïve `git ls-files →
  tar` would have hit, found and fixed during this smoke test. `.gitignored` paths
  (`.env`, `clients/`, `.runstate/`, `node_modules`, `.next`) are excluded by git
  itself.
- **`llm-artifacts` against `~/.claude/projects` (~4.4k files, 464 transcripts).**
  `cleanup` → **pass**, 0 transcripts misplaced in a cache dir. `backup` dry-run →
  **pass**, `expected == archived` (4153 == 4153), caches excluded.
- Both profiles' self-guards exercise the SAME code path offline: the `codebase`
  self-test `git init`s a throwaway copy of its fixtures (so the git-authoritative
  detector runs without a network or a real repo), and both bad fixtures, when
  broken, flip `demo.mjs` to a non-zero exit (regression backstop confirmed).

The remaining real-target gap is the **unattended scheduled run on a specific
operator's host** (claude profile) — the mechanism is identical (same `checks/`
underneath), so the gap is *cron coverage*, not unverified logic.

**Out of code scope (named, not silently skipped).** The **off-system copy** of a
verified archive (the P2 step the tool can only remind about), the **semantic
correctness** of config contents, and backing up deployed app/database state. The
package can preserve and tidy the tree; it cannot make those happen.

**The gap between "this package passes" and "your config is safe."** A green
backup is a *verified local archive*; safety needs the off-system copy this tool
cannot make. A green cleanup is a *tidy layout by these rules*; it is not a
judgement that the files are the right files. Treat any "all green" as "the archive
verified and the layout is tidy today," never as "we are backed up" or "the config
is correct."
