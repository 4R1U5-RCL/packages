# scheduled/ — Layer 2c: the scheduled infra audit (timer)

A timer-triggered runner that executes the **infra subset** of `checks/` plus the
`matrix-freshness` meta-control, from a host that holds the infra credentials CI
deliberately cannot. It closes the gap the other two layers leave: the CI gate
can't reach infra, and the agent run is on-demand — so without this, nothing
*automatically* catches an infra control regressing (an exposed n8n key, egress
isolation silently dropped) or the ATT&CK matrix going stale.

The infra subset now also includes the **logging/detection config** checks
(`supabase-logging`, `gh-secret-scanning`, `device-signin-alerts`,
`vercel-observability`) and the **stubbed `alert-route`**. These return `unknown`
until given live state (a state document fetched from the relevant management API)
or, for `alert-route`, until the n8n channel is wired behind `notify/`. That
`unknown` is the honest unverified outcome, never a silent pass — see
`infra.config.example.json` for how each is wired. (The `app:dynamic` OWASP probes
are NOT run here — they need a deployed staging app and belong to the agent run.)

It is a plain scheduled job invoking `run.mjs` directly — sufficient while the
infra probes are stable. If the probes ever need agent adaptation, swap to a
cron-triggered `SKILL.md` run; the same `checks/` run underneath either way.

## Run it

```sh
node scheduled/infra-audit.mjs --config scheduled/infra.config.json
```

Copy `infra.config.example.json` to `infra.config.json` and fill the real
endpoints. The config's argv uses `$ENV_VAR` tokens that `run.mjs` expands from
the host environment — **no secret sits in the file**.

## Schedule it (cron example)

```cron
# 07:00 daily — infra controls + matrix freshness; append a timestamped log line
0 7 * * *  cd /path/to/packages/audit && \
  N8N_WEBHOOK_URL=... N8N_WEBHOOK_SECRET=... FIRECRAWL_SCRAPE_PROXY_URL=... \
  node scheduled/infra-audit.mjs --config scheduled/infra.config.json \
  >> /var/log/audit-infra.log 2>&1
```

(Set the secret env vars from the host's secret store, not inline as shown.)

## Exit semantics and the freshness split

The runner separates the **security** controls from the **maintenance** control:

- Exit `1` if any infra *security* control (`ssrf`, `webhook-auth`, `dns-auth`,
  and the logging/detection config checks) is a `fail`; exit `2` if any is
  `unknown` (incl. the stubbed `alert-route` and any config check lacking live
  state); else `0`. Wire this to your alerting. An exit `2` here means *not yet
  verified*, not *secure* — treat the stubbed `alert-route` as a standing reminder
  to wire n8n, not as a passing control.
- `matrix-freshness` is reported as a **maintenance** line (`current` /
  `STALE — review & re-map` / `could not verify`) and **never sets the alarm
  code**. A new ATT&CK release is a prompt to review the mapping, not an incident
  and not a deploy block.

## The container-vs-host DNS trap

Run this from a host whose resolver sees public DNS. Inside the studio container,
`dns-auth` can return `unknown` for SPF/DKIM/DMARC names that resolve fine
publicly. `unknown` there is the honest outcome — not a `fail`, never a faked
`pass`. The deterministic proof of the check itself is the `--resolver-fixture`
path exercised in `demo.mjs`.

## Credential handling

This host is the one place that holds infra credentials — exactly the ones CI
can't. They come from the environment, never the repo, never the output. Treat
any key seen in a log as burned and rotate it (the studio's standing PAT-6 / EL-2
discipline). This package audits for leaked secrets; it must never become the
leak.
