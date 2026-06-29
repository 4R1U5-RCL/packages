---
name: consult
description: Cross-validate an answer or a plan through a sequential multi-model chain (base Claude -> GPT-5 -> Gemini 2.5 Pro, optional Perplexity for web facts) routed via a LiteLLM proxy, and report a confidence/risk label derived from inter-model AGREEMENT. Use the `research` flow to answer a question and label confidence (HIGH/MEDIUM/LOW); the `validate` flow to stress-test a plan/proposal (escalates to a third model when >=3 substantive risks surface). The orchestration is self-guarded: it never claims cross-validation it did not actually perform. NOT for one model's opinion, not a fact oracle (a HIGH means models concurred, NOT that the answer is true), and it ASKS before any external web fact-check.
user-invocable: true
---

# consult

The agent-facing entry point of the `consult` package — the studio's multi-model
cross-validation tooling. It folds two operator flows over ONE chain core:

- **`research`** — answer a question through the chain (base -> GPT-5 ->
  Gemini), then label CONFIDENCE from inter-model agreement, and write a cited
  report.
- **`validate`** — cross-validate a plan/proposal: base summary -> GPT-5 finds
  risks -> ESCALATE to Gemini when GPT-5 raises >=3 substantive risks or is
  uncertain. Writes a strengths/risks/alternatives report.

You **call** `run.mjs` / the flow scripts. You never re-describe or reimplement
the chain here — all orchestration lives once in `lib/_chain.mjs`. CI (`ci/`) runs
the offline self-tests as a gate; `scheduled/` is an optional timer. If the chain
must change, change `lib/_chain.mjs`, not this file.

## The discipline (non-negotiable)

- **Confidence is AGREEMENT, not truth.** A HIGH means the models concurred. It
  does NOT mean the answer is correct. State this in every report; verify
  load-bearing facts independently.
- **Never claim cross-validation you didn't perform.** A tier that was unreachable
  or returned a malformed/empty body is NOT corroboration. If no corroborating
  tier responded, the verdict is `unknown` — never a single-model answer dressed
  up as cross-validated, never a fabricated response. `lib/_common.mjs` enforces
  this structurally; still read the `tiers[]`/`corroboration_note` of every
  result and distrust any HIGH where corroborators didn't actually respond.
- **`unknown` is not a soft pass.** Report it as unverified. Do not talk the chain
  into a confident answer to make a run look conclusive.
- **Escalation is mechanical.** `validate` escalates to the third model iff the
  validator raises >= the manifest threshold (3) substantive risks or flags
  uncertainty. You do not decide this; the chain does.
- **ASK before Perplexity.** The optional web fact-check tier reaches the external
  internet. Ask the user before passing `--factcheck`; default is OFF (the tier is
  recorded as skipped, not failed).

## How to run

Offline orchestration self-tests (no proxy, no key — proves the chain logic is
intact before you trust any live run):

```sh
node <skill-dir>/run.mjs --self-test
```

A live flow (needs a reachable LiteLLM proxy; reads `$LITELLM_BASE_URL` and
`$LITELLM_API_KEY` from the environment — never written to a file, never logged).

**YOU are the base tier.** As in the original `/research` and `/validate` skills,
Claude is the base model — so you pass YOUR OWN answer (research) or YOUR OWN
neutral summary + strengths (validate) as `--base-answer`, and the proxy is used
only to have GPT-5 + Gemini cross-validate it. The base answer can be passed
inline (`--base-answer "..."`), from a file (`--base-answer-file path`), or piped
on stdin. The proxy serves no Claude model, so it is **never** called for the
base — only the corroborators (`gpt-5`, `gemini-2.5-pro`, and the consented
`perplexity-sonar` fact-check) go over the wire.

```sh
# research: pass your own answer as the base; GPT-5 + Gemini cross-validate it
node <skill-dir>/run.mjs --flow research --question "..." --base-answer "<your answer>" [--factcheck] [--report out.md]

# validate: pass your own neutral summary + STRENGTH: lines as the base; GPT-5 finds risks
node <skill-dir>/run.mjs --flow validate --plan-file plan.txt --base-answer "<your summary>" [--factcheck] [--report out.md]
```

If no `--base-answer` is supplied, the base model would have to be proxy-reachable
— it is not (no Claude on the proxy) — so the run returns `unknown` with the
message *"no base answer supplied and base model not reachable — the calling agent
must supply its own answer via --base-answer"*. That is honest, not a failure to
work around: supply your answer.

Inspect a single flow against a recorded fixture scenario (offline):

```sh
node <skill-dir>/flows/research.mjs --fixtures fixtures/research/disagree
node <skill-dir>/flows/validate.mjs --fixtures fixtures/validate/risks
```

Each invocation prints one JSON line (the contract in `README.md`): orchestration
`status` (pass/fail/unknown), the separate CONTENT `confidence`
(HIGH/MEDIUM/LOW), `corroborated`, `verdict`, `escalated`, the per-tier
`responded` record, and `negative_control`.

## Assembling the report

- Lead with the honest line: confidence = inter-model agreement, NOT correctness.
- Show which tiers ACTUALLY responded. Never count a non-responding tier as
  corroboration.
- On a `research` divergence, surface BOTH positions (the chain returns them in
  `positions[]`) — do not collapse to the base answer.
- On a `validate` escalation, present strengths, the risks the validator raised,
  and the alternatives/added risks the revalidator returned.
- Separate `unknown` (a tier couldn't be reached/parsed) from a real answer —
  never merge them.

## Files

(All in the same directory as this SKILL.md — the `consult/` package root.)

- `run.mjs` — the dispatcher you invoke; discovers flows from manifests, aggregates.
- `lib/_chain.mjs` — the single home of the chain logic (tier sequencing,
  escalation, scoring, parsing). Takes an injectable `callModel`.
- `lib/_proxy.mjs` — the thin LiteLLM HTTP client (swapped for a fixture loader in self-test).
- `lib/_common.mjs` — the result/verdict contract + the structural honest rules.
- `flows/` — `research.mjs`, `validate.mjs` (thin callers over the chain).
- `manifests/` — fixed tier sets + escalation/scoring policy (not run-time discretion).
- `fixtures/` — recorded proxy responses proving the invariants offline.
- `demo.mjs` — the regression backstop: every flow watched to fire its negative control.
- `README.md` — the output contract, the honest accounting, and the traps.
