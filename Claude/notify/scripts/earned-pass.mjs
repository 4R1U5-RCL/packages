#!/usr/bin/env node
// scripts/earned-pass.mjs — the §3 EARNED-PASS gate for the live channel.
//
// The pass is the message ARRIVING, never a status code (WORKING_METHOD §7). So
// this script reads the n8n EXECUTIONS API to prove what actually happened node
// by node — that the good call's Telegram node ran, and the tampered calls'
// Telegram node did NOT. (n8n returns HTTP 200 even when a node throws before the
// Respond node under responseMode=responseNode — a quirk, so HTTP status is not
// trustworthy here; the execution record is.)
//
// Three probes — watch it FAIL on bad input before trusting it on good input:
//   1. good token + valid signature → Telegram node RAN  → 🟢 lands on your phone
//   2. WRONG token                  → 401/403, no execution at all (Header Auth)
//   3. valid token + BAD signature  → execution ERRORS at verify, Telegram NEVER runs
//
// Reads NOTIFY_WEBHOOK_URL + NOTIFY_TOKEN from the env; N8N_API_KEY + N8N_BASE_URL
// from the env or /studio/.env (to read executions).
// Run: NOTIFY_WEBHOOK_URL=... NOTIFY_TOKEN=... node scripts/earned-pass.mjs

import { readFileSync } from "node:fs";
import { buildRequest } from "../src/client.mjs";

const WF_NAME = "[STUDIO_NOTIFICATIONS] Outbound Alerts";
const TELEGRAM_NODE = "Telegram";

function dotenv(p) { const o={}; try { for (const l of readFileSync(p,"utf8").split("\n")) { const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if(m&&!l.trim().startsWith("#")) o[m[1]]=m[2].replace(/^["']|["']$/g,""); } } catch {} return o; }
const dot = dotenv("/studio/.env");
const E = (k) => process.env[k] ?? dot[k];

const URL = E("NOTIFY_WEBHOOK_URL");
const TOKEN = E("NOTIFY_TOKEN");
const SECRET = E("NOTIFY_SECRET") ?? TOKEN;
const N8N_BASE = (E("N8N_BASE_URL")||"").replace(/\/$/,"");
const N8N_KEY = E("N8N_API_KEY");
if (!URL || !TOKEN) { process.stderr.write("✗ set NOTIFY_WEBHOOK_URL and NOTIFY_TOKEN\n"); process.exit(1); }

const n8n = (p) => fetch(`${N8N_BASE}/api/v1${p}`, { headers: { "X-N8N-API-KEY": N8N_KEY } }).then(r=>r.json());

async function workflowId() {
  const list = await n8n("/workflows?limit=100");
  return (list.data||[]).find(w=>w.name===WF_NAME)?.id;
}
// Latest execution for the workflow, with which nodes ran + status.
async function latestExec(wfId) {
  const j = await n8n(`/executions?workflowId=${wfId}&limit=1&includeData=true`);
  const e = (j.data||[])[0];
  if (!e) return null;
  const rd = e.data?.resultData;
  return { id: e.id, status: e.status, ranNodes: Object.keys(rd?.runData||{}), errorMsg: rd?.error?.message };
}
async function post(headers, body) {
  const res = await fetch(URL, { method:"POST", headers, body });
  return { status: res.status, text: (await res.text()).slice(0,150) };
}

const ev = { source:"claude-code", kind:"attention", message:"🟢 earned-pass ping — channel verified end-to-end.", ts: Date.now() };
let pass = true;
const line = (ok,msg) => { if(!ok) pass=false; process.stdout.write(`  ${ok?"✓":"✗"} ${msg}\n`); };

const wfId = await workflowId();
if (!wfId) { process.stderr.write(`✗ workflow "${WF_NAME}" not found via API — provision first.\n`); process.exit(1); }

// 1. GOOD — Telegram node must actually run.
{
  const { headers, body } = buildRequest(ev, { token:TOKEN, secret:SECRET });
  const r = await post(headers, body);
  const ex = await latestExec(wfId);
  const delivered = r.status<300 && ex?.ranNodes.includes(TELEGRAM_NODE);
  line(delivered, `good token+sig → HTTP ${r.status}, exec ${ex?.id} ran [${ex?.ranNodes.join(", ")}] — Telegram ${delivered?"RAN ✓":"did NOT run"}`);
  process.stdout.write("    → a 🟢 message should now be on your phone.\n");
}
// 2. WRONG TOKEN — rejected at the edge, no node runs.
{
  const { headers, body } = buildRequest(ev, { token:TOKEN, secret:SECRET });
  const r = await post({ ...headers, "X-Notify-Token":"wrong-token" }, body);
  line(r.status===401||r.status===403, `wrong token → HTTP ${r.status} (expect 401/403, rejected at Header Auth, no execution).`);
}
// 3. BAD SIGNATURE — execution must error before Telegram; Telegram must NOT run.
{
  const { headers, body } = buildRequest(ev, { token:TOKEN, secret:SECRET });
  await post({ ...headers, "x-notify-signature":"deadbeef".repeat(8) }, body);
  const ex = await latestExec(wfId);
  const blocked = ex?.status==="error" && !ex.ranNodes.includes(TELEGRAM_NODE);
  line(blocked, `bad signature → exec ${ex?.id} status=${ex?.status}, ran [${ex?.ranNodes.join(", ")}] — Telegram ${ex?.ranNodes.includes(TELEGRAM_NODE)?"RAN ✗":"never ran ✓"} ("${(ex?.errorMsg||"").slice(0,40)}")`);
}

process.stdout.write(`\nearned-pass: ${pass?"PASSED ✓ — good delivers, both tampered calls blocked before Telegram":"FAILED ✗ — characterise before trusting"}\n`);
process.exit(pass?0:2);
