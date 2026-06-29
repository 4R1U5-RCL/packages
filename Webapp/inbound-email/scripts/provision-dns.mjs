#!/usr/bin/env node
// scripts/provision-dns.mjs — ensure + verify the Resend domain for inbound mail
// (idempotent). DOMAIN OPS NEED THE FULL-ACCESS KEY (RESEND_FULL_ACCESS_API_KEY) —
// the send-only key cannot touch /domains.
//
// What it does (re-runnable, no destructive writes):
//   1. find the domain in Resend (GET /domains) or create it (POST /domains).
//   2. print the REQUIRED DNS records the human adds at the registrar exactly
//      once — including the INBOUND MX → inbound-smtp.us-east-1.amazonaws.com
//      (priority 10) — plus the SPF/DKIM/DMARC records Resend returns.
//   3. trigger verification (POST /domains/{id}/verify) and report status.
//
// It does NOT edit registrar DNS itself (the registrar API is provider-specific
// and a human-gated one-time step — see README). It makes the Resend side
// correct and tells you the precise records to publish.
//
// Run:  RESEND_FULL_ACCESS_API_KEY=... node scripts/provision-dns.mjs --domain example.com
//   (--domain also reads INBOUND_DOMAIN; region via --region / INBOUND_REGION,
//    default us-east-1.)

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── env: process.env first, then ~/.claude/inbound-email.env (never committed) ──
function loadEnvFallback() {
  const out = {};
  try {
    const path = join(homedir(), ".claude", "inbound-email.env");
    for (const raw of readFileSync(path, "utf8").split("\n")) {
      if (raw.trim().startsWith("#")) continue;
      const m = raw.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* fallback file is optional */ }
  return out;
}
const fb = loadEnvFallback();
const env = (k) => process.env[k] ?? fb[k];

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function die(msg) { process.stderr.write(`✗ ${msg}\n`); process.exit(1); }

const API_KEY = env("RESEND_FULL_ACCESS_API_KEY");
const DOMAIN = arg("--domain") ?? env("INBOUND_DOMAIN");
const REGION = arg("--region") ?? env("INBOUND_REGION") ?? "us-east-1";
const INBOUND_MX = `inbound-smtp.${REGION}.amazonaws.com`;

if (!API_KEY) die("RESEND_FULL_ACCESS_API_KEY missing (env or ~/.claude/inbound-email.env). Domain ops need the FULL-ACCESS key, not the send-only key.");
if (!DOMAIN) die("domain missing — pass --domain example.com or set INBOUND_DOMAIN.");

const RESEND_API = "https://api.resend.com";
async function api(method, path, body) {
  const res = await fetch(`${RESEND_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`resend ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return json;
}

async function main() {
  // 1. find or create — idempotent: re-running reuses the existing domain.
  const list = await api("GET", "/domains");
  let domain = (list.data || []).find((d) => d.name === DOMAIN);
  if (domain) {
    process.stderr.write(`• reusing existing Resend domain ${domain.id} (${domain.status})\n`);
    domain = await api("GET", `/domains/${domain.id}`); // refresh for full records
  } else {
    process.stderr.write(`• creating Resend domain ${DOMAIN} in ${REGION}\n`);
    domain = await api("POST", "/domains", { name: DOMAIN, region: REGION });
  }

  // 2. the records the human must publish ONCE at the registrar.
  process.stdout.write(`\nDNS records to publish for ${DOMAIN} (one-time, human step):\n`);
  process.stdout.write(`  [INBOUND] MX   @   ${INBOUND_MX}   priority 10\n`);
  for (const r of domain.records || []) {
    process.stdout.write(
      `  [${(r.type || "").toUpperCase().padEnd(5)}] ${(r.name || "@")}  ${r.value}` +
      (r.priority != null ? `  priority ${r.priority}` : "") + "\n",
    );
  }
  if (!domain.records?.length) {
    process.stdout.write(`  (Resend returned no auth records yet — re-run after creation settles, or add SPF/DKIM/DMARC from the Resend dashboard.)\n`);
  }

  // 3. trigger verification and report (idempotent — safe to call repeatedly).
  try {
    await api("POST", `/domains/${domain.id}/verify`);
  } catch (e) {
    process.stderr.write(`(verify trigger: ${e.message})\n`);
  }
  const after = await api("GET", `/domains/${domain.id}`);
  process.stdout.write(
    `\n${after.status === "verified" ? "✓" : "…"} Resend domain ${after.name} status: ${after.status}\n` +
    (after.status === "verified"
      ? `  Inbound + sending ready. Register the webhook → https://<domain>/api/inbound (event: email.received).\n`
      : `  Publish the records above, then re-run this script until status: verified.\n`),
  );
}

main().catch((e) => die(e.message));
