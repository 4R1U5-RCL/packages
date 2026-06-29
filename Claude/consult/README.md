# consult — multi-model cross-validation (research + validate) over one chain

A self-contained, reusable package that runs an answer or a plan through a
sequential LiteLLM model chain — base Claude -> GPT-5 -> Gemini 2.5 Pro, with an
optional Perplexity tier for web fact-checking — routed through a LiteLLM proxy,
with escalation logic and a confidence/risk label derived from inter-model
agreement. It folds two operator flows (`research`, `validate`) over ONE chain
core. The orchestration is the deliverable; the models are what it *coordinates*.

It lives in the reusable-packages monorepo (`4R1U5-RCL/packages`) at `consult/`
and is **consumed by pulling a pinned version**, never copy-forked into a
container (copy-and-fork would recreate exactly the drift surface this kind of
package exists to prevent).

> **The one caveat to carry into every run.** CONFIDENCE measures inter-model
> AGREEMENT, not correctness. A HIGH means the models concurred — it does **NOT**
> mean the answer is true. Model output is non-deterministic, so this package does
> not (and cannot) self-guard the *truth* of an answer. What it self-guards is the
> **orchestration**: it never CLAIMS cross-validation it did not actually perform.
> Absent a reachable proxy, the flows return `unknown` — never a single-model
> answer dressed up as cross-validated, and never a fabricated response.

---

## Architecture — one chain core, two flows, three entry points

```
consult/
├── lib/                    THE deterministic core (single source of truth)
│   ├── _common.mjs           the ONE result/verdict contract + the structural honest rules
│   ├── _chain.mjs            the ONLY home of chain logic: tier sequencing, escalation
│   │                         policy, agreement scoring, response parsing. Injectable
│   │                         callModel => unit-testable with fixtures, no HTTP here.
│   └── _proxy.mjs            the thin LiteLLM HTTP client (the swap-in for the fixture loader)
├── flows/                  thin callers over the chain
│   ├── research.mjs          base -> validator -> revalidator (+optional fact-check), score confidence
│   └── validate.mjs          base summary -> find risks -> ESCALATE on >=3 risks/uncertainty
├── manifests/              fixed scope: tier sets + escalation/scoring policy (not run-time discretion)
├── fixtures/               RECORDED proxy responses — the invariants are provable OFFLINE, no key
│   ├── research/agree, research/disagree
│   ├── validate/risks, validate/clean
│   └── malformed/...         garbage/empty/unreachable bodies => expect unknown
├── run.mjs                 the dispatcher: discover flows from manifests, aggregate, exit codes
├── SKILL.md                ENTRY 1 — agent (on-demand research/validate; asks before Perplexity)
├── ci/                     ENTRY 2 — the strong gate (offline orchestration self-tests, no secrets)
├── scheduled/              ENTRY 3 — optional timer (standing research digest; the weaker fit)
├── demo.mjs                the regression backstop: every flow watched to fire its negative control
└── README.md
```

**The cardinal rule:** the chain logic is in `lib/_chain.mjs` exactly once. All
three entry points **call** it through `run.mjs`/the flow scripts; none
re-describes it as agent-instructions, re-inlines it as CI YAML, or re-rolls it in
a cron job. One chain, one home, three callers.

### The three entry points and why there are three

| Entry | Surface it covers | Why |
|-------|-------------------|-----|
| `SKILL.md` (agent) | on-demand research + validate, full chain incl. consented web fact-check | Only the agent is in a human loop to ask a question, judge taste, and consent to external web. |
| `ci/` (gate) | OFFLINE orchestration self-tests | Deterministic, no secrets: proves the chain logic (escalation/scoring/honesty) didn't regress. It cannot — and should not — gate non-deterministic model *answers*. |
| `scheduled/` (timer) | standing research question(s) on a cadence | The weakest fit: consult is request-driven. Provided for the genuine recurring-question case only; honestly scoped, not padded. |

No entry point is assumed to cover a surface it structurally can't. In particular,
CI does **not** make live model calls, and there is **no scheduled `validate`**
(no human, no plan to point at).

---

## The two vocabularies (read this before trusting a result)

Every flow emits a single JSON object through `lib/_common.mjs`. It carries TWO
deliberately separate fields, because they answer different questions.

```json
{
  "flow": "validate",
  "status": "pass | fail | unknown",
  "confidence": "HIGH | MEDIUM | LOW | null",
  "corroborated": true,
  "verdict": "validated | diverged | partial | clean | escalated | unknown",
  "escalated": true,
  "risk_count": 4,
  "tiers": [ { "role": "base", "model": "claude-opus-4-8", "responded": true, "stance": "concur" } ],
  "positions": [ ... ],
  "evidence": "...",
  "negative_control": { "injected": true, "fired": true, "note": "..." }
}
```

**`status` — the ORCHESTRATION self-guard outcome (only three):**

- **`pass`** — the chain ran as specified AND its negative control fired: on a
  recorded fixture the escalation/scoring invariant was provably exercised (the
  bad input — >=3 risks / a model dissent — was injected and the orchestration
  reacted). Exit code `0`.
- **`fail`** — an orchestration invariant is violated (e.g. escalation did **not**
  fire when >=3 risks were present). A real finding. Exit code `1`.
- **`unknown`** — a tier could not be reached/parsed, or the self-guard could not
  be exercised. **Never a silent pass.** Exit code `2`.

**`confidence` — a SEPARATE field describing INTER-MODEL AGREEMENT about the
content:** `HIGH` / `MEDIUM` / `LOW` (or `null` when there is no answer to rate).
HIGH = the corroborating models concurred. **It is NOT a claim of correctness.**
A `research` divergence returns `LOW` with **both** positions in `positions[]`;
the base answer is never silently kept as truth.

**The honest rules are enforced structurally, not by convention.** `lib/_common.mjs`:

1. downgrades any `status:"pass"` whose negative control did not fire to
   `unknown` (the orchestration honest-pass rule);
2. forces `verdict:"unknown"` (confidence `null`) whenever the base tier did not
   respond, or no corroborating tier responded — a single-model answer is never
   dressed up as cross-validated (the honest-corroboration rule, the direct
   analog of audit's false-pass rule).

A flow physically cannot emit a green it did not earn, nor a "validated" verdict
the corroborating tiers didn't actually back.

---

## Invocation

Offline orchestration self-tests (no proxy, no key):

```sh
node run.mjs --self-test                 # every flow's invariants, aggregated
node flows/research.mjs --self-test      # one flow's self-guard (JSON, exit 0/1/2)
node demo.mjs                            # the full regression backstop
```

A live flow (reads `$LITELLM_BASE_URL` / `$LITELLM_API_KEY` from the environment).
The base tier is **agent-supplied** — Claude IS the base, so the caller passes its
own answer/summary as `--base-answer` (inline, `--base-answer-file`, or stdin) and
the proxy is used only for the corroborators (`gpt-5`, `gemini-2.5-pro`, and the
consented `perplexity-sonar`). No Claude model is ever proxy-called:

```sh
node run.mjs --flow research --question "..." --base-answer "<your answer>" [--factcheck] [--report out.md]
node run.mjs --flow validate --plan-file plan.txt --base-answer "<your summary>" [--factcheck] [--report out.md]
```

With no `--base-answer`, the base model would have to be proxy-reachable (it is
not — no Claude on the proxy), so the run returns `unknown` rather than a
fabricated answer.

Inspect a recorded scenario offline:

```sh
node flows/research.mjs --fixtures fixtures/research/disagree
node flows/validate.mjs --fixtures fixtures/validate/risks
```

---

## Traps (read before believing a result)

- **A HIGH that reads as "true".** It is not. HIGH = the models agreed. Two models
  can confidently agree on a wrong answer. The package surfaces agreement; the
  human verifies facts. This is the whole reason `confidence` is a separate field
  from `status`.
- **A tier that 200s with an empty/garbage body.** That is **not** corroboration.
  `lib/_chain.parseModelResponse` treats any body without a non-empty
  `choices[0].message.content` as "did not respond", and the honest-corroboration
  rule turns "no corroborator responded" into `unknown` — never a faked answer.
- **A proxy that is simply down.** `lib/_proxy.mjs` returns an `{__unreachable}`
  sentinel on any transport failure (no key, network error, non-2xx, non-JSON) —
  it does not throw and does not fabricate. The verdict is `unknown`.
- **Escalation that "looks" like judgement.** It isn't a judgement call — it is
  mechanical: `validate` escalates iff the validator raises >= the manifest
  threshold (3) substantive risks or flags uncertainty. The threshold lives in
  `manifests/validate.json`, not in code branches.
- **Non-deterministic output sneaking into CI.** It can't: the gate is
  offline-only against recorded fixtures. Live calls happen only on operator /
  scheduled runs.

---

## Secrets handling

The LiteLLM proxy URL and key are read from the host environment
(`$LITELLM_BASE_URL` / `$LITELLM_API_KEY`) **only** — never written to a file,
never logged, never echoed into output (not even on an HTTP error, where only the
status code is reported). Fixtures use obviously-fake placeholder content. Any key
seen in a log or a chat is treated as burned and rotated (the studio's standing
PAT-6 / EL-2 discipline).

---

## How this package is consumed

The harness and container **pull a pinned version** of this repo and reference
`consult/` in place. They do not hold an editable second copy. One source of
truth, versioned, pulled where needed. Pin to a tag; bump the pin deliberately.

---

## Scope boundary

- **In scope:** the package — `lib/` (the chain core + the two structural honest
  rules), `flows/` (thin callers), `manifests/` (fixed tier sets + escalation/
  scoring policy), `fixtures/` proving the invariants offline, `SKILL.md`, the
  `ci/` gate, the optional `scheduled/` digest — plus a demonstration run.
- **Out of scope (named, not silently skipped):** the *truth* of any model answer
  (non-deterministic, not machine-checkable here); the model weights / the proxy
  itself; and any guarantee that a HIGH is correct. The package can report
  agreement and refuse to overstate it; it cannot adjudicate facts.
- **The honest line:** this delivers verified *orchestration* — a chain that runs
  as specified and never claims corroboration it didn't perform. It does not make
  an answer true. A green run never overstates itself.

---

## Honest accounting

**Built and verified** (watched to fire its negative control on a recorded
fixture). Both flows; the single result/verdict contract with its two structural
honest rules; the fixed manifests; the injectable-`callModel` chain core; the
dispatcher; and all three entry points. The invariants are proven OFFLINE with no
API key:

- escalation FIRES on the >=3-risk fixture and does NOT fire on the clean fixture;
- agreement scores HIGH; divergence scores LOW with both positions surfaced;
- a malformed/empty body and an unreachable proxy both yield `unknown`, never a
  fabricated cross-validated answer.

`demo.mjs` proves all of the above and that the dispatcher introduces no false
pass; it exits non-zero if any flow stops being able to fire its negative control
(verified by deliberately dropping the risks fixture below the threshold, watching
`demo.mjs` go red, then restoring it).

**LIVE-verified against the proxy.** The live path (`lib/_proxy.mjs` -> a real
LiteLLM proxy -> real corroborator calls) has been exercised end-to-end. The base
tier is **supplied by the calling agent** (Claude IS the base, as in the original
`/research` and `/validate` skills) — it is never proxy-called, because the proxy
serves no Claude model. Only the corroborators go over the wire: `gpt-5`,
`gemini-2.5-pro`, and the consented `perplexity-sonar` fact-check.

- A live `research` run with `--base-answer "Paris."` to *"What is the capital of
  France?"*: base `responded=true` (`via: agent`), `gpt-5` and `gemini-2.5-pro`
  both responded and concurred → `status=pass`, `confidence=HIGH`,
  `verdict=validated`, `corroborated=true`.
- A live `validate` run with an agent-supplied base summary against a risky plan:
  `gpt-5` raised ≥3 substantive risks and dissented → escalation fired per the
  manifest ≥3 rule (`escalated=true`, `verdict=escalated`). When the revalidator
  (`gemini-2.5-pro`) timed out, it was recorded `responded=false` and NOT counted
  as corroboration — `confidence` stayed honest (MEDIUM), never fabricated.
- With no `--base-answer` and the base model unreachable, the run returns
  `unknown` ("the calling agent must supply its own answer via --base-answer") —
  never a single-model answer dressed up as cross-validated.

It is the SAME orchestration code the fixtures exercise (the fixture loader is a
drop-in for `_proxy.mjs`), so the offline invariants and the live transport are
now both confirmed. The API key is read from the environment only and never
appears in any emitted output (grep-verified on the live runs above).

**The weaker-fit entry point, said plainly.** `scheduled/` is provided but
honestly scoped: consult is request-driven, so a timer fits only the narrow
standing-research-question case. There is no scheduled `validate`. See
`scheduled/README.md`.

**The gap between "this package passes" and "the answer is correct."** A green run
here means the chain ran as specified and its self-guard fired — it is *not* a
statement that any answer is true. Closing that gap is non-technical and outside
this package: human review of the content, independent verification of
load-bearing facts, and domain judgement. consult shortens the path to a
*cross-checked* answer with its agreement honestly labelled; it does not certify
the answer. Treat any HIGH as "the models concurred today," never as "this is
true."
