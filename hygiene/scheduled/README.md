# scheduled/ — the strong automation layer (timer)

This is the entry point hygiene is actually **for**. A timer-triggered runner,
executed from the host that owns the real `~/.claude`, doing the two things that
genuinely need to happen automatically and unattended:

1. **`backup --apply`** — write a fresh, self-**verified** archive of the tree.
   This is the action that must succeed; it drives the runner's exit code. A
   backup that does not verify (missed files / not stable / not extractable) is an
   incident, not a silent pass.
2. **`cleanup` (drift report, dry-run)** — report stray files but **do not move
   them**. Moving files mutates the operator's home tree, so it stays human-gated:
   the timer only *surfaces* drift; a human runs `cleanup --apply` after reviewing.

It is a thin wrapper over `run.mjs` — the same `checks/` run underneath. It
re-describes no logic.

## Run it

```sh
node scheduled/hygiene-cron.mjs --target ~/.claude
# or
node scheduled/hygiene-cron.mjs --config scheduled/hygiene.config.json
```

Copy `hygiene.config.example.json` to `hygiene.config.json` and set `target`.
There are **no secrets** in this config — hygiene reads no credentials, only a
path. That is the honest difference from audit's scheduled runner, which exists
*because* it holds infra creds; this one holds none.

## Schedule it (cron example)

```cron
# 03:00 daily — verified backup of ~/.claude + a drift report; timestamped log
0 3 * * *  cd /path/to/packages/hygiene && \
  node scheduled/hygiene-cron.mjs --target "$HOME/.claude" \
  >> /var/log/hygiene.log 2>&1
```

## Exit semantics — backup is the alarm, drift is a prompt

- Exit `1` if the backup is a `fail`; `2` if `unknown`; else `0`. Wire this to
  alerting — a failing/unverifiable backup is the thing worth waking up for.
- **Drift never sets the alarm code.** Stray files are reported as a maintenance
  line (`N stray — review, then run cleanup --apply`) and left for a human, exactly
  as audit keeps `matrix-freshness` off its security alarm. Auto-moving files in
  someone's home tree on a timer is the kind of unattended mutation this package
  refuses to do.

## The off-system reminder (P2)

When the backup is written and verified, the runner echoes the backup control's
own reminder: **an archive is not a backup until a copy lives off this host.**
Copying it off-system is a human step the timer cannot do for you — it surfaces
the reminder; it does not pretend to satisfy it.
