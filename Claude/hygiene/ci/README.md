# ci/ — the drift gate (a weak fit, scoped honestly)

The pipeline-facing entry point: the `cleanup` control in CHECK mode, run as a
pre-merge gate that blocks on drift, no agent in the loop.

## Read this first — why this is a weaker fit than audit's gate

audit's CI gate is a strong fit: a code repo is *already* git-tracked, so gating a
push on a repo finding is natural. hygiene tends a **config tree on a host**
(`~/.claude`), which is usually **not** a git repo at all. So this gate only makes
sense in one narrow case:

- **The config tree is itself version-controlled** (a dotfiles repo, or a
  `~/.claude` kept under git). Then a PR that drops a `handoff_*.md` at the root
  instead of `data/handoffs/` is real drift a gate can catch before merge.

If your `~/.claude` is just a live directory on a host — the common case — **this
gate has nothing to stand on** and the *scheduled runner* (`scheduled/`) is the
real automation. We are not going to pad this layer to look symmetrical with
audit's three-layer story; it is honestly the minor one here.

## What it does — and what it deliberately omits

- Runs **`cleanup` only**, dry-run (CHECK mode): reports stray files and blocks
  the build on drift. It never moves files in CI.
- **`backup` is intentionally absent.** A stateless CI runner is the wrong place
  to write a preservation archive of a host's home tree — the tree isn't even
  present in CI. Backups belong on the scheduled host (`scheduled/`).

## Wiring it into a tracked config repo

1. Copy `hygiene-gate.yml` into the repo's `.github/workflows/`.
2. Pin `HYGIENE_PKG_REF` to a released tag of `4R1U5-RCL/packages`. Bump it
   deliberately — the package is consumed by *pulling a pinned version*, never by
   holding an editable copy.
3. If `4R1U5-RCL/packages` is private, add a read token secret and uncomment the
   `token:` line.

## Exit semantics

`run.mjs` exits `0` (tidy), `1` (drift — stray files), or `2` (could not scan).
The gate blocks on **both** `1` and `2`: a tree the detector could not scan must
not slip through as if it were tidy.

## Run it locally (same thing the gate runs)

```sh
node run.mjs --only cleanup --target /path/to/config-tree
```
