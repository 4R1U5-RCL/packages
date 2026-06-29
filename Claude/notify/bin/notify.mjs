#!/usr/bin/env node
// packages/notify/bin/notify.mjs — the Claude Code HOOK entry point.
//
// Registered as the command for the Claude Code `Notification` and `Stop` hooks
// (see ../hooks/settings.snippet.json). Claude Code passes the hook payload as
// JSON on STDIN (hook_event_name, cwd, session_id, and a message field). This
// script reads that, formats a one-line Telegram message, and POSTs it through
// the shared seam (../src/client.mjs) to the hosted [STUDIO_NOTIFICATIONS] flow.
//
//   node bin/notify.mjs --kind=attention   # Notification hook (needs input)
//   node bin/notify.mjs --kind=complete    # Stop hook (query finished)
//
// FAIL-SAFE: this process ALWAYS exits 0 and never throws — a webhook outage can
// never block or disrupt a Claude Code session. The delivery result is printed
// to stderr (visible in hook output) so it stays observable, but it is never
// fatal. That is the intended trade for a notifier, recorded honestly — no
// `|| true` shell guard is needed because the fail-safety lives here.
//
// CONFIG (resolved in this order, first hit wins):
//   1. process.env: NOTIFY_WEBHOOK_URL, NOTIFY_TOKEN, NOTIFY_SECRET (opt),
//      NOTIFY_ON_STOP (opt, '1' to enable completion pings).
//   2. ~/.claude/notify.env — KEY=VALUE lines (gitignored, chmod 600). Lets the
//      secret live outside any committed settings file and outside the shell env.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { notify } from "../src/client.mjs";
import { bodyFromTranscript } from "../src/extract.mjs";

function hhmm() {
  const d = new Date();
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

// ── tiny KEY=VALUE loader for ~/.claude/notify.env (no deps) ──────────────────
function loadEnvFile(path) {
  const out = {};
  try {
    for (const raw of readFileSync(path, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const k = line.slice(0, eq).trim();
      let v = line.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      out[k] = v;
    }
  } catch { /* absent file is fine — env may carry the values instead */ }
  return out;
}

function cfgValue(key, fileEnv) {
  return process.env[key] ?? fileEnv[key];
}

async function readStdin() {
  // The hook payload arrives on stdin. Read it best-effort; an empty/garbled
  // payload must degrade to a generic message, never crash the hook.
  try {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    const txt = Buffer.concat(chunks).toString("utf8").trim();
    return txt ? JSON.parse(txt) : {};
  } catch {
    return {};
  }
}

function argKind(argv) {
  const a = argv.find((x) => x.startsWith("--kind="));
  const k = a ? a.split("=")[1] : "attention";
  return k === "complete" ? "complete" : "attention";
}

async function main() {
  const kind = argKind(process.argv.slice(2));
  const fileEnv = loadEnvFile(join(homedir(), ".claude", "notify.env"));

  // Completion pings are OPT-IN (decision: NOTIFY_ON_STOP). Without it, Stop is
  // a silent no-op so the channel stays signal, not chatter.
  if (kind === "complete" && cfgValue("NOTIFY_ON_STOP", fileEnv) !== "1") {
    process.exit(0);
  }

  const payload = await readStdin();
  const url = cfgValue("NOTIFY_WEBHOOK_URL", fileEnv);
  const token = cfgValue("NOTIFY_TOKEN", fileEnv);
  const secret = cfgValue("NOTIFY_SECRET", fileEnv) ?? token;

  if (!url || !token) {
    // LOUD not-wired notice — never a silent success (audit §7 discipline).
    process.stderr.write(
      "[studio-notify] NOT WIRED — set NOTIFY_WEBHOOK_URL + NOTIFY_TOKEN " +
      "(env or ~/.claude/notify.env). Nothing sent.\n");
    process.exit(0);
  }

  const where = payload.cwd ? basename(payload.cwd) : "session";
  const title = kind === "complete" ? `🟢 Claude Code done — ${where}` : `🟡 Claude Code needs input — ${where}`;

  // FREE local summary from the transcript (no LLM, no cost, never leaves the box).
  // Degrades to whatever prompt text the hook carried if the transcript is absent.
  let summary = "";
  if (cfgValue("NOTIFY_SUMMARY", fileEnv) !== "0") {
    const maxChars = Number(cfgValue("NOTIFY_SUMMARY_MAXCHARS", fileEnv)) || 2500;
    try { if (payload.transcript_path) summary = bodyFromTranscript(payload.transcript_path, { maxChars }); } catch { /* degrade */ }
  }
  if (!summary) {
    summary = String(payload.message ?? payload.notification ?? payload.body ??
      (kind === "complete" ? "Finished responding." : "Waiting on you."));
  }

  const meta = {
    cwd: payload.cwd ?? null,
    session: payload.session_id ? String(payload.session_id).slice(0, 8) : null,
    at: hhmm(),
  };

  // n8n composes: title + summary + footer(meta). bin sends the parts.
  const res = await notify({ source: "claude-code", kind, message: title, summary, meta }, { url, token, secret });

  process.stderr.write(
    `[studio-notify] ${res.delivered ? "delivered ✓" : "NOT delivered ✗"} ` +
    `(status ${res.status}) — ${res.note}\n`);
  process.exit(0); // fail-safe: never block Claude Code, whatever happened.
}

main();
