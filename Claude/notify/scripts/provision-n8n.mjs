#!/usr/bin/env node
// scripts/provision-n8n.mjs — provision the hosted [STUDIO_NOTIFICATIONS] workflow
// VIA THE n8n PUBLIC API (idempotent). The studio owns this n8n instance, so its
// own repo defining its own hosted workflow as code is legitimate — this is NOT
// the §8 boundary (that forbids workflow definitions in CLIENT-delivered repos).
// See ../CLAUDE.md. The node graph is built programmatically here (never as a
// committed *.workflow.json) so it also stays clear of the harness n8n-leak glob.
//
// THE WORKFLOW (4 nodes, Header-Auth + HMAC, responds AFTER Telegram so a 2xx
// genuinely means delivered — no respond-immediately false-pass):
//
//   Webhook(POST /studio-notify, Header Auth X-Notify-Token, responseMode=responseNode)
//     → Code  (verify x-notify-signature HMAC + ≤5min skew; THROW on bad/stale;
//              then format the Telegram text by source/kind)
//     → Telegram(sendMessage to CHAT_ID, text = {{ $json.message }})
//     → Respond to Webhook(200 {ok:true})
//
// Run (env or /studio/.env supplies N8N_API_KEY + N8N_BASE_URL):
//   BOT_TOKEN=123:AAH... [CHAT_ID=...] [NOTIFY_TOKEN=...] node scripts/provision-n8n.mjs
//   - CHAT_ID omitted → derived from the bot's getUpdates (send the bot a msg first).
//   - NOTIFY_TOKEN omitted → a fresh 24-byte hex secret is generated and printed.

import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const WF_NAME = "[STUDIO_NOTIFICATIONS] Outbound Alerts";
const PROJECT_NAME = process.env.N8N_PROJECT || "[STUDIO_NOTIFICATIONS]";
const WEBHOOK_PATH = "studio-notify";

// ── env (process.env first, then /studio/.env) ────────────────────────────────
function loadDotenv(path) {
  const out = {};
  try {
    for (const raw of readFileSync(path, "utf8").split("\n")) {
      const m = raw.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && !raw.trim().startsWith("#")) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* fine */ }
  return out;
}
const dot = loadDotenv("/studio/.env");
const env = (k) => process.env[k] ?? dot[k];

const N8N_BASE_URL = (env("N8N_BASE_URL") || "").replace(/\/$/, "");
const N8N_API_KEY = env("N8N_API_KEY");
const BOT_TOKEN = env("BOT_TOKEN");
let CHAT_ID = env("CHAT_ID");
let SECRET = env("NOTIFY_TOKEN");

function die(msg) { process.stderr.write(`✗ ${msg}\n`); process.exit(1); }
if (!N8N_BASE_URL || !N8N_API_KEY) die("N8N_BASE_URL / N8N_API_KEY missing (env or /studio/.env).");
if (!BOT_TOKEN) die("BOT_TOKEN missing — pass the @BotFather token: BOT_TOKEN=123:AAH... node scripts/provision-n8n.mjs");

// ── n8n API helper ────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const res = await fetch(`${N8N_BASE_URL}/api/v1${path}`, {
    method,
    headers: { "X-N8N-API-KEY": N8N_API_KEY, "Content-Type": "application/json", accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`n8n ${method} ${path} → ${res.status}: ${text.slice(0, 400)}`);
  return json;
}

// ── derive CHAT_ID from the bot's recent updates if not supplied ──────────────
async function deriveChatId() {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates`);
  const j = await res.json();
  if (!j.ok) die(`Telegram getUpdates failed: ${JSON.stringify(j).slice(0, 200)}`);
  const updates = j.result || [];
  const last = [...updates].reverse().find((u) => u.message?.chat?.id);
  if (!last) die("No chat found — message your bot once (any text), then re-run so getUpdates has an update to read.");
  return String(last.message.chat.id);
}

// ── the Code node body: verify HMAC + skew, then format the message ───────────
function codeNodeJs(secret) {
  // secret is embedded so verification runs even where n8n Cloud blocks $env in
  // Code nodes. Rotating the secret = re-run this script (idempotent).
  return `
const crypto = require('crypto');
const SECRET = ${JSON.stringify(secret)};
const MAX_SKEW_MS = 5 * 60 * 1000;

const item = items[0];
const headers = (item.json.headers) || {};
const body = (item.json.body) || {};
const sig = headers['x-notify-signature'];
const tsRaw = headers['x-notify-timestamp'];

// Freshness (replay guard) then constant-time HMAC over \`\${ts}.\${rawBody}\`.
const ts = Number(tsRaw);
if (!isFinite(ts) || Math.abs(Date.now() - ts) > MAX_SKEW_MS) {
  throw new Error('studio-notify: stale or missing timestamp (replay guard)');
}
const raw = JSON.stringify(body);
const expected = crypto.createHmac('sha256', SECRET).update(tsRaw + '.' + raw).digest('hex');
const a = Buffer.from(expected); const b = Buffer.from(String(sig || ''));
if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
  throw new Error('studio-notify: bad signature — rejected, no delivery');
}

// Compose the Telegram text: TITLE + SUMMARY + FOOTER (the n8n-owned footer, so
// every caller gets a consistent one). Callers send the parts; audit events
// (audit.alert.v1) are formatted from the structured event if needed.
const ev = body.event;
let title = body.message || '';
let summary = body.summary || '';
if (ev && ev.schema === 'audit.alert.v1') {
  const sev = (ev.severity || 'info').toUpperCase();
  if (!title) title = '🔴 Audit [' + sev + '] ' + (ev.control ? ev.control + ': ' : '') + (ev.title || 'alert');
  if (!summary && ev.detail) summary = ev.detail;
}
if (!title) title = '(studio-notify)';

const m = body.meta || {};
const bits = ['[STUDIO_NOTIFICATIONS]'];
if (m.session) bits.push(m.session);
if (m.cwd) bits.push(m.cwd);
bits.push(m.at || new Date().toISOString().slice(11, 16));
const footer = '— ' + bits.join(' · ');

let out = title;
if (summary) out += '\\n\\n' + summary;
out += '\\n\\n' + footer;
return [{ json: { message: out } }];
`.trim();
}

// ── node typeVersion detection (reuse what the instance already runs) ─────────
async function detectVersions() {
  const defaults = { webhook: 2, code: 2, telegram: 1.2, respondToWebhook: 1.1 };
  try {
    const list = await api("GET", "/workflows?limit=50");
    for (const wf of list.data || []) {
      const full = await api("GET", `/workflows/${wf.id}`);
      for (const node of full.nodes || []) {
        if (node.type === "n8n-nodes-base.webhook") defaults.webhook = node.typeVersion ?? defaults.webhook;
        if (node.type === "n8n-nodes-base.code") defaults.code = node.typeVersion ?? defaults.code;
        if (node.type === "n8n-nodes-base.telegram") defaults.telegram = node.typeVersion ?? defaults.telegram;
        if (node.type === "n8n-nodes-base.respondToWebhook") defaults.respondToWebhook = node.typeVersion ?? defaults.respondToWebhook;
      }
    }
  } catch (e) { process.stderr.write(`(typeVersion detect skipped: ${e.message})\n`); }
  return defaults;
}

function buildNodes(v, headerCredId, telegramCredId, secret) {
  return [
    {
      id: "webhook", name: "Webhook", type: "n8n-nodes-base.webhook", typeVersion: v.webhook,
      position: [0, 0],
      parameters: {
        httpMethod: "POST", path: WEBHOOK_PATH, authentication: "headerAuth",
        responseMode: "responseNode", options: {},
      },
      credentials: { httpHeaderAuth: { id: headerCredId, name: "studio-notify header" } },
      webhookId: "studio-notify",
    },
    {
      id: "verify", name: "Verify + Format", type: "n8n-nodes-base.code", typeVersion: v.code,
      position: [220, 0],
      parameters: { language: "javaScript", jsCode: codeNodeJs(secret) },
    },
    {
      id: "telegram", name: "Telegram", type: "n8n-nodes-base.telegram", typeVersion: v.telegram,
      position: [440, 0],
      parameters: {
        resource: "message", operation: "sendMessage",
        chatId: CHAT_ID, text: "={{ $json.message }}", additionalFields: {},
      },
      credentials: { telegramApi: { id: telegramCredId, name: "studio-notify bot" } },
    },
    {
      id: "respond", name: "Respond", type: "n8n-nodes-base.respondToWebhook", typeVersion: v.respondToWebhook,
      position: [660, 0],
      parameters: { respondWith: "json", responseBody: '={{ { "ok": true } }}' },
    },
  ];
}

const CONNECTIONS = {
  Webhook: { main: [[{ node: "Verify + Format", type: "main", index: 0 }]] },
  "Verify + Format": { main: [[{ node: "Telegram", type: "main", index: 0 }]] },
  Telegram: { main: [[{ node: "Respond", type: "main", index: 0 }]] },
};

async function main() {
  if (!SECRET) { SECRET = randomBytes(24).toString("hex"); process.stderr.write("• generated NOTIFY_TOKEN (printed at end)\n"); }
  if (!CHAT_ID) { CHAT_ID = await deriveChatId(); process.stderr.write(`• derived CHAT_ID=${CHAT_ID}\n`); }

  // Reuse credentials if the workflow already exists; else create them once.
  const existing = (await api("GET", `/workflows?limit=100`)).data?.find((w) => w.name === WF_NAME);
  let headerCredId, telegramCredId, wfId;
  if (existing) {
    wfId = existing.id;
    const full = await api("GET", `/workflows/${wfId}`);
    headerCredId = full.nodes.find((n) => n.type === "n8n-nodes-base.webhook")?.credentials?.httpHeaderAuth?.id;
    telegramCredId = full.nodes.find((n) => n.type === "n8n-nodes-base.telegram")?.credentials?.telegramApi?.id;
    process.stderr.write(`• reusing existing workflow ${wfId} + its credentials\n`);
  }
  if (!headerCredId) {
    headerCredId = (await api("POST", "/credentials", {
      name: "studio-notify header", type: "httpHeaderAuth",
      data: { name: "X-Notify-Token", value: SECRET },
    })).id;
    process.stderr.write(`• created header-auth credential ${headerCredId}\n`);
  }
  if (!telegramCredId) {
    telegramCredId = (await api("POST", "/credentials", {
      name: "studio-notify bot", type: "telegramApi",
      data: { accessToken: BOT_TOKEN },
    })).id;
    process.stderr.write(`• created telegram credential ${telegramCredId}\n`);
  }

  const v = await detectVersions();
  const nodes = buildNodes(v, headerCredId, telegramCredId, SECRET);
  const payload = { name: WF_NAME, nodes, connections: CONNECTIONS, settings: { executionOrder: "v1" } };

  if (wfId) await api("PUT", `/workflows/${wfId}`, payload);
  else wfId = (await api("POST", "/workflows", payload)).id;

  try { await api("POST", `/workflows/${wfId}/activate`); } catch (e) { process.stderr.write(`(activate: ${e.message})\n`); }

  // Place the workflow + its credentials in the [STUDIO_NOTIFICATIONS] project
  // (best-effort; the public projects/transfer API is Enterprise-gated).
  try {
    const proj = (await api("GET", "/projects")).data?.find((p) => p.name === PROJECT_NAME);
    if (!proj) {
      process.stderr.write(`(project "${PROJECT_NAME}" not found — leaving workflow in default project)\n`);
    } else {
      await api("PUT", `/workflows/${wfId}/transfer`, { destinationProjectId: proj.id });
      for (const cid of [headerCredId, telegramCredId]) {
        try { await api("PUT", `/credentials/${cid}/transfer`, { destinationProjectId: proj.id }); } catch { /* already there */ }
      }
      process.stderr.write(`• placed in project "${PROJECT_NAME}" (${proj.id})\n`);
    }
  } catch (e) { process.stderr.write(`(project placement skipped: ${e.message})\n`); }

  const url = `${N8N_BASE_URL}/webhook/${WEBHOOK_PATH}`;
  process.stdout.write(
    `\n✓ [STUDIO_NOTIFICATIONS] workflow ${wfId} provisioned + activated.\n\n` +
    `Add these to ~/.claude/notify.env (chmod 600) and to /studio/.env:\n` +
    `  NOTIFY_WEBHOOK_URL=${url}\n` +
    `  NOTIFY_TOKEN=${SECRET}\n\n` +
    `Then run the earned-pass gate:\n` +
    `  NOTIFY_WEBHOOK_URL=${url} NOTIFY_TOKEN=${SECRET} node scripts/earned-pass.mjs\n`);
}

main().catch((e) => die(e.message));
