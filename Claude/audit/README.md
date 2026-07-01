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
│   ├── rls.mjs               \   repo · static
│   ├── revoke.mjs             |  repo · static
│   ├── secret-leak.mjs        |  repo · static
│   ├── security-headers.mjs   |  app  · static   (OWASP A05)
│   ├── dependency-audit.mjs   |  app  · static   (OWASP A06)
│   ├── app-logging.mjs        |  app  · static   (OWASP A09)
│   ├── access-probe.mjs       |  app  · dynamic  (OWASP A01 — IDOR)
│   ├── cookie-flags.mjs       |  app  · dynamic  (OWASP A07)
│   ├── ssrf.mjs               |  infra· dynamic  (OWASP A10 — also app endpoints, via config)
│   ├── webhook-auth.mjs       |  one self-guarding script per control —
│   ├── dns-auth.mjs           |  the ONLY place each check's logic lives
│   ├── supabase-logging.mjs   |  infra· dynamic  (logging config)
│   ├── gh-secret-scanning.mjs |  infra· dynamic  (detection config)
│   ├── device-signin-alerts.mjs| infra· dynamic  (detection config)
│   ├── vercel-observability.mjs| infra· dynamic  (detection config)
│   ├── alert-route.mjs        |  infra· dynamic  (STUBBED — n8n pending; unknown by construction)
│   └── matrix-freshness.mjs  /  (verifies the bundled ATT&CK version is current)
├── notify/                 the alert-dispatch SEAM — send_alert(event); currently a self-declaring STUB
│   ├── notify.mjs            the contract; replace its body with a signed POST to n8n later
│   └── README.md             the event payload shape the n8n side builds against
├── manifests/              fixed evidence manifests (what each check pulls — not model discretion)
├── fixtures/               a known-BAD and known-GOOD target per check (proof the check catches a bad input)
├── mapping/                ATT&CK ID × ISO × SOC reference + pinned ATTACK_VERSION
│   ├── controls.json         machine-readable citation per control (the checks read this)
│   ├── security-coverage-matrix.md   human-readable coverage table
│   └── ATTACK_VERSION        the ATT&CK release the mapping targets (currently Enterprise 19.1)
├── run.mjs                 the dispatcher: select by surface + reachability, aggregate results
├── SKILL.md                LAYER 2a — agent entry point (full cross-surface audit, on demand)
├── ci/                     LAYER 2b — CI gate (static subset: repo + app:static, at deploy)
├── scheduled/              LAYER 2c — scheduled runner (infra subset + freshness, on a timer)
└── README.md
```

**The cardinal rule:** every check is a script in `checks/` exactly once. All
three entry points **call** it; none re-describes it as agent-instructions,
re-inlines it as CI YAML, or re-rolls the probe in a cron job. One check, one
home, three callers.

### The three entry points and why there are three

| Layer | Entry point | What it covers | Why |
|-------|-------------|----------------|-----|
| 2a | `SKILL.md` (agent) | **repo + app + infra** (full cross-surface, incl. app:dynamic) | Only the agent can reach and adapt to live hosted infra and a deployed staging app; on-demand. |
| 2b | `ci/` (gate) | **static subset** (`--reachability static`: repo + app:static) | CI's sandbox can't hold infra credentials or run the app to probe it. Blocks deploy on any source-reachable finding. |
| 2c | `scheduled/` (timer) | **infra + freshness** | Runs from a host that *does* hold infra credentials, closing the gap the CI gate structurally can't. |

Together: source-reachable controls (repo + app:static) are enforced
automatically at deploy (2b), infra controls are checked automatically on a
schedule (2c), and a complete cross-surface audit — the only path that also runs
the **app:dynamic** OWASP probes against a deployed staging app — is available on
demand (2a). No layer is assumed to cover a surface it structurally can't.

---

## The surface split (and the reachability axis)

Each check declares a **surface** (where the control lives) and a
**reachability** (`static` = verifiable from source/build; `dynamic` = needs a
live endpoint). The dispatcher keys on reachability, so each entry point selects
exactly the subset it can run: `static` checks are invoked with `--target <repo>`
(CI-runnable); `dynamic` checks are invoked with `--config` (a live endpoint or a
state document), and return `unknown` when no live config is supplied.

- **`repo` · static** — read from a repo checkout: `rls`, `revoke`,
  `secret-leak`. (RLS/REVOKE in `packages/db`, secret-leak scanning + `.env`
  hygiene.)
- **`app` · static** — OWASP checks verifiable against the delivered app's
  source/build: `security-headers` (A05), `dependency-audit` (A06),
  `app-logging` (A09). These run in the CI gate alongside the repo checks.
- **`app` · dynamic** — OWASP checks that need the app *running*:
  `access-probe` (A01 — IDOR) and `cookie-flags` (A07). They run via the agent
  path against a **deployed staging app**, never the CI gate (which has no app to
  probe). `ssrf` (A10) is reused here — point it at an app endpoint via config.
- **`infra` · dynamic** — probe hosted services: `ssrf` (Firecrawl scrape path),
  `webhook-auth` (n8n webhooks), `dns-auth` (Resend sending domain); the
  logging/detection **config** checks `supabase-logging`, `gh-secret-scanning`,
  `device-signin-alerts`, `vercel-observability`, and `alert-route` (stubbed —
  see below); and the meta-control `matrix-freshness` (MITRE's published ATT&CK
  release).

### One check per boundary (reuse, not duplication)
`access-probe` is the app-dynamic view of the SAME access-control boundary
`rls`/`revoke` verify in policy — it does not re-implement RLS reasoning. A10
SSRF on app endpoints reuses `ssrf` via config, not a second script. A06 is
satisfied by `dependency-audit` (which doubles as the "Dependabot enabled"
logging-config row). One boundary, one check, consumed by whichever surfaces need
it (WORKING_METHOD §5/D8).

### The alert route is deliberately stubbed
`alert-route` depends on a notification channel that does not exist yet — an n8n
workflow will be wired behind the `notify/` seam. Against the stub it reports
**`unknown`** (an honest *unverified*), never a pass; it cannot flip to `pass`
until a real test event is watched to arrive. See `notify/README.md`. Only the
*configuration* half of logging/detection is mechanical and lives here; the
*practice* (reading alerts, IR execution) stays in the companion docs, never
faked as a green check.

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

The dispatcher selects by **surface** and/or **reachability** and aggregates:

```sh
node run.mjs --surface repo   --target /path/to/repo
node run.mjs --surface app    --target /path/to/repo --config staging.config.json
node run.mjs --surface infra  --config infra.config.json
node run.mjs --reachability static --target /path/to/repo   # CI profile: repo + app:static
node run.mjs --surface all    --target /path/to/repo --config infra.config.json   # full cross-surface
```

`--surface` (`all|repo|infra|app`) and `--reachability` (`static|dynamic`)
compose: the CI gate uses `--reachability static`; the scheduled runner uses
`--surface infra`; the agent uses `--surface all` with a config that also points
the app:dynamic probes at a deployed staging app.

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

- **In scope:** the package — `checks/` (self-guarding, surface- and
  reachability-tagged, three surfaces repo/app/infra, incl. `matrix-freshness`),
  `fixtures/` proving each catches a known-bad input, `manifests/`, `mapping/`
  (+ pinned `ATTACK_VERSION`), the `notify/` alert-dispatch seam (stubbed),
  `SKILL.md`, `ci/` gate (static subset: repo + app:static), `scheduled/`
  infra+freshness audit — plus a demonstration run.
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
fired). All **seventeen** checks across three surfaces — the original seven plus
the OWASP `app` checks (`security-headers` A05, `dependency-audit` A06,
`app-logging` A09, `access-probe` A01/IDOR, `cookie-flags` A07) and the
logging/detection **config** checks (`supabase-logging`, `gh-secret-scanning`,
`device-signin-alerts`, `vercel-observability`) — the single output contract with
its structural honest-pass rule (now carrying `reachability`), the fixed
manifests, the live-verified ATT&CK×ISO×SOC mapping (Enterprise 19.1), the
dispatcher (surface × reachability), and the three entry points. `demo.mjs` proves
all seventeen earn their verdicts and the dispatcher introduces no false pass; it
exits non-zero if any check stops being able to fail its bad fixture.

**Unverified by design — the alert route.** `alert-route` depends on a
notification channel that does not exist yet. The `notify/` seam is a
self-declaring **stub** (it logs loudly and returns a distinct `not-wired`
status, never a silent success). The check's *detector* is proven (it tells a
delivered alert from a failed one via mock notifiers), but against the live stub
it reports **`unknown` by construction** — an honest unverified — and must not
flip to `pass` until the n8n workflow is wired and a real test event is watched to
arrive. This is the correct state, not a gap to paper over.

**Reuse, not duplication** (one check per boundary). A01 broken access control is
single-homed: `rls`/`revoke` (policy, repo) and `access-probe` (the same boundary
through the running app). A10 SSRF on app endpoints reuses `ssrf` via config — no
second script. A06 is `dependency-audit`. The handoff's "reuse the existing
Dependabot/SCA check" was inaccurate (no such check existed) — it was built fresh
and noted as such in its mapping rationale.

**Built, proven against fixtures, but not yet exercised against live targets.**
The infra security checks (`ssrf`, `webhook-auth`, `dns-auth`) and the
logging/detection config checks are proven offline against mocks/state-fixtures
that *model* the control; the app:dynamic checks (`access-probe`, `cookie-flags`)
are proven against bundled vulnerable mock apps. Their live posture is unverified
until pointed at real endpoints / a deployed staging app — and they say so: absent
a live target they return `unknown`, never a silent pass. `matrix-freshness` *is*
live-verified (it reached MITRE's real feed and confirmed 19.1). Known depth gaps,
flagged in their manifests: `webhook-auth` exercises but does not actively probe
replay rejection; `ssrf` cannot settle the hosted Firecrawl egress posture from
outside; `secret-leak` matches known key *shapes*; `app-logging`/`security-headers`
verify control *wiring/presence*, not the completeness of what is logged or the
strictness of a CSP policy.

**Named OWASP gaps — not built as hollow checks** (a check that can't fail a
fixture isn't a check). A02 Cryptographic Failures (TLS/at-rest depth), A03
Injection (live-payload and the Firecrawl→dashboard stored-XSS render path), A04
Insecure Design (auth rate-limiting / business-logic abuse), and A08 Data
Integrity (CI/CD pipeline integrity) each need a live target or are
judgemental/low-confidence as static patterns. They are named here rather than
faked green, and can be promoted to real fixtured checks later.

**Practice, not check — the companion layer.** This package builds only the
*configuration* half of logging/detection (controls installed and enabled). The
*practice* — reading alerts, triage, incident-response execution — has no
mechanical ground truth and lives in the Incident-Response / Logging & Detection
docs, never in `checks/`.

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
