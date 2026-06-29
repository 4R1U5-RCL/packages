# ci/ — Layer 2b: the CI gate (repo subset)

The pipeline-facing entry point. The same `checks/` scripts, invoked
deterministically as a pre-deploy / pre-push gate with no agent in the loop,
blocking the build on a finding.

## What it covers — and the honest limit

It covers the **repo subset only**: `rls`, `revoke`, `secret-leak`. A CI sandbox
cannot safely hold the credentials to probe your hosted n8n encryption key,
Firecrawl egress, or Resend DNS — those live outside any repo and outside CI's
reach. So coverage is split across the three entry points:

- **this gate (2b)** — repo controls, automatically, at deploy;
- **the scheduled runner (2c)** — infra controls, automatically, on a timer, from
  a host that holds the infra credentials;
- **the agent run (2a, `SKILL.md`)** — the full cross-surface audit, on demand.

Do not assume this gate covers a surface it structurally can't.

## Wiring it into a client repo

1. Copy `audit-gate.yml` into the client repo's `.github/workflows/`.
2. Pin `AUDIT_PKG_REF` to a released tag of `4R1U5-RCL/packages`. Bump it
   deliberately — the package is consumed by *pulling a pinned version*, never by
   holding an editable copy.
3. If `4R1U5-RCL/packages` is private, add a read token secret and uncomment the
   `token:` line.

## Exit semantics

`run.mjs` exits `0` (all pass), `1` (a finding), or `2` (a control could not be
verified). The gate blocks on **both** `1` and `2`: a repo control that CI cannot
verify must not slip through as if it passed.

## Run it locally (same thing the gate runs)

```sh
node run.mjs --surface repo --target /path/to/client/repo
```
