# notify — Claude Code → Telegram notifier

A self-contained, reusable package: a Claude Code `Notification`/`Stop` hook POSTs
a **signed** event to the studio's hosted `[STUDIO_NOTIFICATIONS]` n8n workflow,
which sends a **Telegram** message (🟡 needs input / 🟢 done). Studio ops tooling —
it notifies the operator; it never ships inside a client build.

> Mirrored in the studio monorepo at `studio/packages/notify`. This copy
> (`4R1U5-RCL/packages`) is canonical and consumed by a pinned version; keep the
> two in sync (code is byte-identical — only the docs differ by context).

```
src/client.mjs    the signed seam: buildRequest() (pure) + notify() (fail-soft)
bin/notify.mjs    the hook entry — reads stdin JSON, POSTs the event
scripts/
  selftest.mjs       offline earned checks (no network)
  provision-n8n.mjs  provision/activate the n8n workflow via the public API
  earned-pass.mjs    live gate: delivers on good input, rejects bad input
hooks/settings.snippet.json   the Notification + Stop hooks to merge into settings
```

## Auth (two gates, one secret)

1. **`X-Notify-Token`** — n8n Header Auth; a wrong/absent token is rejected 401 at
   the edge before any node runs.
2. **HMAC-SHA256 `x-notify-signature`** over `${ts}.${body}` (+ `x-notify-timestamp`,
   ≤5-min skew) — integrity + replay guard, matching the studio's existing n8n
   contract and the `audit` package's `webhook-auth` discipline (sign, don't post
   unsigned). The workflow verifies it and drops bad/stale calls before Telegram.

## One-time human setup (Telegram side)

1. **@BotFather** → `/newbot` (or `/mybots` to reuse one) → copy the bot token.
2. Send the bot any one message (so `getUpdates` has something to read).
3. Hand the token to provisioning. Chat ID is derived; the secret is generated.

## Provision (needs the bot token; n8n creds via env or /studio/.env)

```bash
N8N_BASE_URL=... N8N_API_KEY=... BOT_TOKEN=8123...:AAH... node scripts/provision-n8n.mjs
```

Builds + activates the 4-node workflow (Webhook → verify+format → Telegram →
Respond) and places it in the `[STUDIO_NOTIFICATIONS]` n8n project. The graph is
built in code — there is no committed `*.workflow.json` (the hosted workflow is
studio infra, not a client deliverable). Prints the `NOTIFY_WEBHOOK_URL` +
`NOTIFY_TOKEN` to store. Then prove it:

```bash
NOTIFY_WEBHOOK_URL=... NOTIFY_TOKEN=... node scripts/earned-pass.mjs   # executions-API verified
```

## Wire the Claude Code hooks

Put the secret where the hook can read it (outside any committed file):

```bash
# ~/.claude/notify.env   (chmod 600)
NOTIFY_WEBHOOK_URL=https://csco.app.n8n.cloud/webhook/studio-notify
NOTIFY_TOKEN=<secret>
NOTIFY_ON_STOP=1     # optional — also ping on completion (off = attention only)
```

Merge `hooks/settings.snippet.json` into `~/.claude/settings.json` (all sessions)
or a project `.claude/settings.json`. The hook command is fail-safe: `bin/notify.mjs`
always exits 0, so a webhook outage can never block a session.

## Second caller: the audit package

`audit/notify/notify.mjs` (`send_alert`) wires to the SAME workflow by replacing
its stub body with a signed POST (`audit.alert.v1` events → 🔴 alert format), which
flips audit's `alert-route` check `unknown → pass`. Audit stays self-contained
(its own signed POST, node built-ins only) — it does not import this package.

## Boundary

OUTBOUND only. Replying to *resume* a session (inbound dialogue) is out of scope.
