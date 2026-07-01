# ops-agents — scheduled studio-ops agents (dry-run by default)

Durable, committed home for the studio's **ops-agents** — the autonomous,
read-only gatherers that sweep the 4R1U5-RCL estate and emit a digest, deferring
every guarded write to the main session. Ported here (Node-built-ins-only `.mjs`,
no npm deps) from studio's ephemeral `clients/_ops-agents/` so a nightly schedule
has a permanent place to run from.

```
ops-agents/
  guard.mjs                       the guarded-write SAFETY GUARD (port of @studio/agent-kit/guard)
  nightly-sweep.mjs               [AGENT] nightly Dependabot + audit sweep (standalone)
  scheduled/
    nightly-sweep.mjs             the timer-triggered DRY-RUN runner (spawns the agent, never --apply)
    nightly-sweep.config.example.json   declarative schedule spec the main session applies
```

## Why it lives here, not in studio

`clients/_ops-agents` is gitignored/ephemeral. A durable nightly schedule needs a
committed home, and this packages repo already hosts the ops-tooling tree
(`Claude/audit`, `Claude/notify`, `Claude/consult`) and the scheduled-runner
pattern (`Claude/audit/scheduled/`). The one blocker was that `@studio/agent-kit`
(a `/studio` workspace package) does not resolve here — resolved by:

- **guard:** vendored as the local dependency-free `guard.mjs` (faithful port of
  `@studio/agent-kit/guard` — the load-bearing safety primitive; it must travel
  with the agent, so it is carried, not re-imported).
- **notify:** the agent uses this repo's **existing** `../notify/src/client.mjs`
  seam directly (the `@studio/notify` twin), instead of the studio notify wrapper.

Net: zero `@studio/*` imports; the agent runs standalone from `/root/packages`.

## The guarded-write discipline (kept intact)

- **DRY-RUN IS THE DEFAULT.** No `--apply` ⇒ GATHER (read-only) + report + digest.
- **`--apply` only ARMS the deferred plan** for the main session — it performs
  ZERO guarded I/O here. Merging a green patch/minor Dependabot PR (`gh … merge`)
  and applying an audit fix (`git push`) are represented via `deferGuardedWrite`
  and handed to the main session, never performed by the agent.
- **`--selftest`** runs the dry-run gather IN-PROCESS under `assertNoGuardedWrites`
  (the fetch + child_process spy) so a stray guarded write is caught in-agent.

## Run it

```sh
node nightly-sweep.mjs --selftest        # in-process guard proof (stubbed seams, no network)
node nightly-sweep.mjs                    # real dry-run gather + digest
node scheduled/nightly-sweep.mjs          # the scheduled DRY-RUN runner (human summary + machine JSON)
```

The agent reaches live `gh` (read-only) for Dependabot PRs across
`studio / tessera / mosaic / packages`, derives a per-repo audit signal (the
local `Claude/audit` tool when a checkout is provided, else read-only
`gh api …/code-scanning/alerts`), and emits a Telegram digest through the
`../notify` webhook seam. Any absent cred is an honest-skip with a note — never a
crash, never a fabricated send.

## Proposed schedule (the main session applies this)

- **Cadence:** nightly **07:00 UTC** — `cron: 0 7 * * *` (same clock as
  `audit/scheduled`, and well within the hourly `/schedule` minimum).
- **Mode:** DRY-RUN. The `/schedule` routine runs `scheduled/nightly-sweep.mjs`,
  which never forwards `--apply`.
- **Target:** Telegram, via the hosted `[STUDIO_NOTIFICATIONS]` n8n workflow
  (`NOTIFY_WEBHOOK_URL` / `NOTIFY_TOKEN` from the host environment).
- Full spec: `scheduled/nightly-sweep.config.example.json`.

### Cron example (host crontab, for reference)

```cron
# 07:00 daily — nightly Dependabot + audit sweep, DRY-RUN; append a timestamped log
0 7 * * *  cd /path/to/packages/Claude/ops-agents && \
  NOTIFY_WEBHOOK_URL=... NOTIFY_TOKEN=... \
  node scheduled/nightly-sweep.mjs >> /var/log/nightly-sweep.log 2>&1
```

(Set the secret env vars from the host's secret store, not inline as shown.)

## Credential handling

Creds come from the environment, never the repo, never the output. Reads only:
the guard blocks any `gh … merge` / `git push` / `vercel deploy` / `.env` write.
Treat any key seen in a log as burned and rotate it (standing PAT-6 / EL-2
discipline).
