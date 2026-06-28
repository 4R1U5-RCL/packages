# scheduled/ — the optional timer (the weaker-fit entry point)

A timer-triggered runner that re-runs standing research question(s) through the
chain on a cadence. **Read this honestly:** it is the weakest-fit of the three
entry points for consult.

## Why it's a weak fit (and what it's actually for)

`audit` has a natural scheduled surface — infra drifts on its own, so a timer
catches an exposed key or a stale matrix without anyone asking. `consult` does
not work like that. It is **request-driven**: the natural trigger for a cross-
model consult is a human asking a question or proposing a plan. There is no
standing state that silently regresses and needs a watcher.

So this runner is scoped to the one genuine recurring case: a **standing research
question** you want re-answered through the chain on a schedule (a weekly "what
changed in X" digest). That is useful, but narrow — do not mistake it for
consult's primary surface. The primary surfaces are:

- **the agent run (`SKILL.md`)** — on-demand research/validate, the main way in;
- **the CI gate (`ci/`)** — the offline orchestration self-tests, the strong gate.

There is deliberately **no scheduled `validate`**: validating a plan with no human
in the loop has nothing to act on and no plan to point at.

## Run it

```sh
node scheduled/research-digest.mjs --config scheduled/consult.config.json
```

Copy `consult.config.example.json` to `consult.config.json` and list the standing
question(s). It is a thin wrapper over `run.mjs --flow research`; the chain logic
lives once in `lib/_chain.mjs`.

## Schedule it (cron example)

```cron
# 08:00 Monday — re-run standing research questions through the chain
0 8 * * 1  cd /path/to/packages/consult && \
  LITELLM_BASE_URL=... LITELLM_API_KEY=... \
  node scheduled/research-digest.mjs --config scheduled/consult.config.json \
  >> /var/log/consult-digest.log 2>&1
```

(Set the proxy env vars from the host's secret store, not inline as shown.)

## Honest caveats

- **Confidence is agreement, not truth.** A scheduled HIGH still only means the
  models concurred this run; nobody reviewed it. Treat the digest as a prompt to
  look, not as a verified fact.
- **`unknown` on an unreachable proxy.** If the proxy is down or a tier returns a
  malformed body, the run is `unknown` — never a fabricated cross-validated
  answer. Exit `2` flags it for your alerting.
- **External web is opt-in.** Perplexity fact-check runs only for questions with
  `factcheck:true`. An unattended job reaching the external internet is a
  deliberate choice, never a default.

## Credential handling

The proxy URL + key come from the host environment, never the config file, never
the output. Treat any key seen in a log as burned and rotate it (the studio's
standing PAT-6 / EL-2 discipline).
