# audit — ATT&CK × ISO × SOC security verification for the studio stack

A self-contained, reusable package that **verifies** the studio stack's security
posture against the MITRE ATT&CK Enterprise matrix, with each control mapped to
ISO 27001:2022 Annex A and SOC 2 Common Criteria. It is the deliverable; the
controls are what it *checks*.

It lives in the reusable-packages monorepo (`4R1U5-RCL/packages`) at `audit/`
and is **consumed by pulling a pinned version**, never copy-forked into a
container (copy-and-fork would recreate exactly the drift surface this kind of
package exists to prevent).

> **The one caveat to carry into every run.** ATT&CK coverage measures *which
> techniques this package checks*, not whether the stack is correct. A green run
> on a misconfigured policy is worse than a red one. Every `pass` in this package
> is *earned* — watched to fail on a deliberately-vulnerable fixture — never
> assumed. This package does not make anything certified or attested; it delivers
> the technical verification substance of an ATT&CK-mapped, ISO/SOC-aligned audit.

---

## Architecture — one package, three layers, every check exactly once

```
audit/
├── checks/                 LAYER 1 — the deterministic core (single source of truth)
│   ├── _common.mjs           the ONE output contract + the structural honest-pass rule
│   ├── _sqlutil.mjs          shared SQL/file parsing for the repo checks
│   ├── rls.mjs               \
│   ├── revoke.mjs             |
│   ├── secret-leak.mjs        |  one self-guarding script per control —
│   ├── ssrf.mjs               |  the ONLY place each check's logic lives
│   ├── webhook-auth.mjs       |
│   ├── dns-auth.mjs           |
│   └── matrix-freshness.mjs  /  (verifies the bundled ATT&CK version is current)
├── manifests/              fixed evidence manifests (what each check pulls — not model discretion)
├── fixtures/               a known-BAD and known-GOOD target per check (proof the check catches a bad input)
├── mapping/                ATT&CK ID × ISO × SOC reference + pinned ATTACK_VERSION
│   ├── controls.json         machine-readable citation per control (the checks read this)
│   ├── security-coverage-matrix.md   human-readable coverage table
│   └── ATTACK_VERSION        the ATT&CK release the mapping targets (currently Enterprise 19.1)
├── run.mjs                 the dispatcher: select checks by surface, aggregate results
├── SKILL.md                LAYER 2a — agent entry point (full cross-surface audit, on demand)
├── ci/                     LAYER 2b — CI gate (repo subset, at deploy)
├── scheduled/              LAYER 2c — scheduled runner (infra subset + freshness, on a timer)
└── README.md
```

**The cardinal rule:** every check is a script in `checks/` exactly once. All
three entry points **call** it; none re-describes it as agent-instructions,
re-inlines it as CI YAML, or re-rolls the probe in a cron job. One check, one
home, three callers.

### The three entry points and why there are three

| Layer | Entry point | Surface it covers | Why |
|-------|-------------|-------------------|-----|
| 2a | `SKILL.md` (agent) | **repo + infra** (full cross-surface) | Only the agent can reach and adapt to live hosted infra; on-demand. |
| 2b | `ci/` (gate) | **repo only** | CI's sandbox can't safely hold credentials to probe live infra. Blocks deploy on a repo finding. |
| 2c | `scheduled/` (timer) | **infra + freshness** | Runs from a host that *does* hold infra credentials, closing the gap the CI gate structurally can't. |

Together: repo controls are enforced automatically at deploy (2b), infra controls
are checked automatically on a schedule (2c), and a complete cross-surface audit
is available on demand (2a). No layer is assumed to cover a surface it
structurally can't.

---

## The surface split

Each check declares a surface so each entry point selects exactly the subset it
can run.

- **`repo` controls** — read from a repo checkout: `rls`, `revoke`,
  `secret-leak`. (RLS/REVOKE in `packages/db`, secret-leak scanning + `.env`
  hygiene.)
- **`infra` controls** — probe hosted services: `ssrf` (Firecrawl scrape path),
  `webhook-auth` (n8n webhooks), `dns-auth` (Resend sending domain), and the
  meta-control `matrix-freshness` (MITRE's published ATT&CK release).

---

## The output contract (read this before trusting a result)

Every check emits a single JSON object through `checks/_common.mjs`. There is
exactly one definition of a result and one definition of the honest-pass rule.

```json
{
  "control": "rls",
  "surface": "repo",
  "status": "pass | fail | unknown",
  "evidence": "...",
  "negative_control": { "injected": true, "fired": true, "note": "..." },
  "attack": [ { "id": "T1213", "name": "...", "tactic": "..." } ],
  "iso27001_2022": [ { "control": "A.8.3", "name": "..." } ],
  "soc2_cc": [ { "id": "CC6.1", "name": "..." } ]
}
```

**Status vocabulary — only three:**

- **`pass`** — the control is present *and* its negative control fired (the bad
  input was provably injected and provably caught). Exit code `0`.
- **`fail`** — the control is absent, or the bad input was *not* caught. A real
  finding. Exit code `1`.
- **`unknown`** — could not determine: target unreachable, parse miss, the bad
  input could not be injected, a network error. **Never a silent pass.** Exit
  code `2`.

**The honest-pass rule is enforced structurally, not by convention.**
`_common.mjs` downgrades any `pass` whose negative control did not fire to
`unknown`. A check physically cannot emit a green it did not earn. This is the
whole point of the package (WORKING_METHOD §7/§8): *"it passed" is the product.*
A check that cannot be made to genuinely fail on a vulnerable fixture isn't a
check yet — it reports `none`/`unknown`, not `done`.

Citations are not stored in the checks. They live once in
`mapping/controls.json` and are looked up by control id, so the mapping is the
single source of truth and each check just names its control (cite inline,
WORKING_METHOD §1).

---

## Invocation

Each check runs standalone:

```sh
node checks/rls.mjs --target /path/to/repo      # judge a target
node checks/rls.mjs --self-test                 # just run the self-guard against fixtures
```

The dispatcher runs a surface subset and aggregates:

```sh
node run.mjs --surface repo  --target /path/to/repo
node run.mjs --surface infra --config infra.config.json
node run.mjs --surface all   --target /path/to/repo --config infra.config.json
```

---

## Traps (read before believing a result)

- **DNS resolves differently inside vs. outside the container.** A live
  `dns-auth --domain ...` can return `unknown` in-container even when the SPF/
  DKIM/DMARC records exist publicly. That is why `dns-auth` supports
  `--resolver-fixture` and why resolution failure is `unknown`, never `fail`.
- **An endpoint that 200s without enforcing auth.** `webhook-auth` therefore
  *first* confirms a correctly-signed payload is accepted, so that a rejection of
  an unsigned payload means enforcement — not a dead endpoint. If even the valid
  payload is rejected, the result is `unknown`.
- **A "blocked" verdict from a dead service.** `ssrf` first sends a benign
  external target to confirm the endpoint is alive before concluding that a
  blocked internal target means SSRF protection.
- **A stale matrix that reads as 100% green.** `matrix-freshness` exists because
  a mapping built against an old ATT&CK release silently goes stale. A network or
  parse error there is `unknown`, never a silent "current".
- **Secrets in this package's own context.** This package *audits* for committed
  secrets; it must never *become* the leak. Fixtures use only obviously-fake
  placeholder secrets; real `.env` files are gitignored at the monorepo root.

---

## Credential handling (scheduled host)

The scheduled runner (2c) is the one place that holds infra credentials — exactly
the credentials CI deliberately cannot. They are read from the host environment /
a config file, never committed, never echoed into output. Any key observed in a
log or a chat is treated as burned and rotated (the studio's standing PAT-6 /
EL-2 discipline).

---

## How this package is consumed

The harness and container **pull a pinned version** of this repo and reference
`audit/` in place. They do not hold an editable second copy. One source of truth,
versioned, pulled where needed. Pin to a tag; bump the pin deliberately.

---

## Scope boundary

- **In scope:** the package — `checks/` (self-guarding, surface-tagged, incl.
  `matrix-freshness`), `fixtures/` proving each catches a known-bad input,
  `manifests/`, `mapping/` (+ pinned `ATTACK_VERSION`), `SKILL.md`, `ci/` gate
  (repo subset), `scheduled/` infra+freshness audit — plus a demonstration run.
- **Out of scope (named, not silently skipped):** purely *organisational*
  controls — documented policies, incident response, the SOC 2 observation
  window, audit engagement. The package can *report their absence* as findings;
  it cannot implement them.
- **The honest line:** this delivers the technical verification substance of an
  ATT&CK-mapped, ISO/SOC-aligned audit. It does not make anything certified or
  attested. A green run never overstates itself.

---

## Honest accounting

**Built and verified** (watched to fail a vulnerable fixture; negative control
fired). All seven checks, the single output contract with its structural
honest-pass rule, the fixed manifests, the live-verified ATT&CK×ISO×SOC mapping
(Enterprise 19.1), the dispatcher, and the three entry points. `demo.mjs` proves
all seven earn their verdicts and the dispatcher introduces no false pass; it
exits non-zero if any check stops being able to fail its bad fixture.

**Built, proven against fixtures, but not yet exercised against live infra.** The
three infra security checks (`ssrf`, `webhook-auth`, `dns-auth`) are proven
offline against mocks/fixtures that *model* the control. Their live posture is
unverified until pointed at real endpoints with credentials — and they say so:
absent a live target they return `unknown`, never a silent pass. `matrix-freshness`
*is* live-verified (it reached MITRE's real feed and confirmed 19.1). Known depth
gaps, all flagged in their manifests: `webhook-auth` exercises but does not
actively probe replay rejection; `ssrf` cannot settle the hosted Firecrawl egress
posture from outside; `secret-leak` matches known key *shapes*, not arbitrary
high-entropy tokens.

**Out of code scope (named, not silently skipped).** Purely organisational SOC 2
controls — documented policies, incident response, the observation window, the
audit engagement itself. This package can *report their absence* as a finding; it
cannot implement them.

**The cost gap between "this package passes" and "certified/attested."** A green
run here is technical verification substance — it is *not* a certification or an
attestation, and the distance to one is large and mostly non-technical: a defined
control set and system boundary, a multi-month SOC 2 observation window with
collected evidence, an independent auditor's engagement and report, and the
organisational controls above. This package shortens the *technical* preparation
for such an audit; it does not stand in for the audit. Treat any "100% green" as
"the techniques we check passed today," never as "the stack is secure" or
"we are compliant."

## Notes on what was probed, not recalled (WORKING_METHOD §6)

- **Runtime is Node.js (v22), not Python.** The container has no Python; the
  handoff's `*.py` filenames were illustrative. Node is also the better fit — it
  matches the stack being audited (a pnpm/TypeScript monorepo) and needs **zero
  npm dependencies** (`node:crypto`, `node:dns`, `node:net`, global `fetch`).
- **ATT&CK is at Enterprise v19.1**, not the handoff's placeholder "17.1"
  (verified live against MITRE's STIX release feed; v19 renamed tactic TA0005 to
  "Stealth" and replaced T1656 with T1684). `mapping/ATTACK_VERSION` pins 19.1 and
  records the live poll source.
- Manifests point at **real** paths/endpoints captured from the live `/studio`
  repo and infra config, not guessed ones.
