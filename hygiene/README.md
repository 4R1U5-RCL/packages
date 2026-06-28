# hygiene — self-verifying backup + config-drift detection for the IOPHON tree

A self-contained, reusable package that **tends** the IOPHON home config tree
(default `~/.claude`, overridable with `--target`). It folds two operator skills
into hardened, self-guarded units:

- **`backup`** — a PRESERVATION action that self-verifies: it creates a `.tar.gz`
  (+ sha256 + a manifest of entries) and only declares `pass` when the archive was
  created *and verified* — its sha256 is stable on re-read, it is extractable, and
  every in-scope file is present in the listing (proving it captured the tree, not
  an empty/partial tar).
- **`cleanup`** — a DRIFT DETECTOR: it scans the tree for stray files that violate
  the canonical §2 directory layout (which kind of file belongs in which subdir).
  `pass` = tidy (zero stray), `fail` = drift, `unknown` = couldn't scan. It also
  has a human-gated `--apply` mode that MOVES each stray to its canonical dir.

It lives in the reusable-packages monorepo (`4R1U5-RCL/packages`) at `hygiene/`
and is **consumed by pulling a pinned version**, never copy-forked into a host
(a copy-and-fork would recreate exactly the drift this kind of package exists to
prevent).

> **The one caveat to carry into every run.** A `pass` means the *action* held —
> the archive verified, or the tree is tidy by the rules in `manifests/cleanup.json`.
> It does **not** mean your data is safe or your config is correct. A backup that
> verifies locally is still not a backup until a copy lives **off this host** (the
> human-gated P2 step the tool reminds you about but cannot perform). And cleanup
> only knows the kinds of files it has rules for — it tidies the layout, it does
> not judge the contents. Every `pass` here is *earned* (watched to fail a
> deliberately-bad input), never assumed.

---

## Architecture — one package, two controls, every action exactly once

```
hygiene/
├── checks/                 the deterministic core (single source of truth)
│   ├── _common.mjs           the ONE output contract + the structural honest-pass rule
│   ├── _fsutil.mjs           shared fs helpers: walk a tree, classify a path against
│   │                         the cleanup rules, tar+gzip (spawns system `tar`), sha256,
│   │                         archive verify, sentinel injection, guarded move
│   ├── cleanup.mjs           CONTROL: drift detector (+ guarded --apply mover)
│   └── backup.mjs            CONTROL: create + self-verify an archive (+ --apply writes it)
├── manifests/              the FIXED scope of each control (not model discretion)
│   ├── cleanup.json          canonical directory rules: pattern → dest subdir (§2 layout)
│   └── backup.json           include roots + exclude globs for the archive
├── fixtures/               a known-GOOD and known-BAD tree per control
│   ├── cleanup/good · cleanup/bad     tidy tree vs. a tree with stray files
│   └── backup/tree                    a small tree the backup self-test archives
├── run.mjs                 the dispatcher: discover controls, run, aggregate, exit codes
├── SKILL.md                agent entry point (on-demand; the only mutating caller)
├── ci/                     CI drift gate (a weak fit — see ci/README.md)
├── scheduled/              the STRONG automation: timer that backs up + reports drift
├── demo.mjs                the smoke-test: proves both controls earn their verdicts
└── README.md
```

**The cardinal rule:** each control's logic is a script in `checks/` exactly once.
All three entry points **call** it; none re-describes it as agent-instructions,
re-inlines it as CI YAML, or re-rolls it in a cron job. One control, one home,
three callers.

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

Each control runs standalone:

```sh
node checks/cleanup.mjs --target /path/to/tree          # dry-run drift report
node checks/cleanup.mjs --target /path/to/tree --apply  # MOVE stray files (guarded)
node checks/cleanup.mjs --self-test                     # prove the detector works

node checks/backup.mjs  --target /path/to/tree          # dry-run: build + verify in temp
node checks/backup.mjs  --target /path/to/tree --apply  # WRITE + re-verify the real archive
node checks/backup.mjs  --self-test                     # prove the verifier works
```

The dispatcher runs both and aggregates:

```sh
node run.mjs --target ~/.claude                 # both, dry-run
node run.mjs --only backup --apply --target ~/.claude
node run.mjs --self-test                        # every control's negative control
```

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
- **Rules are scope, not omniscience.** `manifests/cleanup.json` is the FIXED set
  of kinds cleanup knows. A file of an *unknown* kind is not drift — it is simply
  out of scope, reported as neither stray nor in-place. Add a rule to extend scope.

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

**Built, but exercised against a real `~/.claude` only on the host.** The live
**scheduled run** over an operator's actual home tree (`backup --apply` writing a
real archive into `data/backups/`, and the drift report over real content) is
proven here against fixtures and temp copies, but its behaviour on a specific
host's tree is only seen when run there. The mechanism is identical — the same
`checks/` underneath — so the gap is *coverage of one real tree*, not unverified
logic.

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
