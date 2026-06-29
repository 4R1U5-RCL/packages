# ci/ — the strong gate (offline orchestration self-tests)

The pipeline-facing entry point. It runs `run.mjs --self-test` (and `demo.mjs`)
as a pre-deploy / pre-push gate with no agent and no live models in the loop,
blocking the build if the chain logic regresses.

## Why this is the gate that fits consult — and the honest limit

consult is **request-driven** and its model output is **non-deterministic**, so
CI cannot gate on the *truth* of an answer. What CI *can* gate — deterministically,
offline, with zero secrets — is the **orchestration**:

- escalation fires on >=3 risks and **not** otherwise,
- agreement scores HIGH, divergence scores LOW (both positions surfaced),
- a malformed / unreachable tier yields `unknown`, never a fabricated
  cross-validated answer.

All of these are proven against the bundled RECORDED fixtures, so the gate needs
no `LITELLM_*` credentials. That is deliberate: a live proxy in CI would mean
holding an API key in the sandbox to pay for non-deterministic output that could
not block a build anyway. **Live model calls are out of CI's honest reach** — they
happen only on an operator run (`SKILL.md`) or the optional scheduled job, pointed
at a real proxy.

Do not extend this gate to make live calls. If the chain logic changes, the gate
catches the regression; if a model's *answer* changes, that is not a CI concern.

## Wiring it into a repo

1. Copy `consult-selftest.yml` into the repo's `.github/workflows/`.
2. Pin `CONSULT_PKG_REF` to a released tag of `4R1U5-RCL/packages`. Bump it
   deliberately — the package is consumed by *pulling a pinned version*, never by
   holding an editable copy.
3. If `4R1U5-RCL/packages` is private, add a read token secret and uncomment the
   `token:` line.

## Exit semantics

`run.mjs --self-test` exits `0` (all flows' invariants hold), `1` (an invariant is
violated — a real orchestration finding), or `2` (a self-guard could not be
exercised). The gate blocks on **both** `1` and `2`.

## Run it locally (same thing the gate runs)

```sh
node run.mjs --self-test
node demo.mjs
```
