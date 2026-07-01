#!/usr/bin/env node
// scheduled/nightly-sweep.mjs — the timer-triggered DRY-RUN runner for the
// nightly-sweep ops-agent.
//
// Mirrors ../../audit/scheduled/infra-audit.mjs: a plain scheduled job that
// invokes the agent as a subprocess, surfaces its human summary on stderr, and
// writes the machine report to stdout for an alerting wrapper. It runs the agent
// in DRY-RUN ONLY and NEVER passes --apply — arming the deferred plan (the PR
// merges + audit-fix pushes) is a main-session decision, never the scheduler's.
//
//   node scheduled/nightly-sweep.mjs
//
// Credentials come from the host environment (never the repo, never the config):
//   NOTIFY_WEBHOOK_URL / NOTIFY_TOKEN [/ NOTIFY_SECRET]  — the Telegram digest seam.
//   gh auth (GH_TOKEN or `gh auth login`)                — the read-only PR/audit reads.
// With any absent, the agent honest-skips that gather and still emits a report —
// never a crash, never a fabricated send.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT = join(HERE, "..", "nightly-sweep.mjs");

// DRY-RUN is forced. This runner deliberately never forwards --apply.
const r = spawnSync("node", [AGENT, "--dry-run"], { encoding: "utf8" });

let report;
try {
  report = JSON.parse(r.stdout);
} catch {
  process.stderr.write("nightly-sweep: agent produced no parseable report\n");
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(2);
}

// Human summary on stderr (the alerting wrapper reads the JSON on stdout).
process.stderr.write("\n== scheduled nightly sweep (DRY-RUN) ==\n");
process.stderr.write(`${report.summary}\n`);
const warns = report.findings.filter((f) => f.severity === "warn" || f.severity === "high").length;
process.stderr.write(`findings: ${report.findings.length} (${warns} warn/high) · deferred: ${report.deferred.length} · armed: ${report.armed}\n`);
process.stderr.write(`digest: ${report.digest?.delivered ? "delivered ✓" : `not sent — ${report.digest?.skipped ?? "n/a"}`}\n`);
for (const n of report.notes ?? []) process.stderr.write(`  note: ${n}\n`);

// Machine report to stdout for an alerting wrapper to consume.
process.stdout.write(JSON.stringify({ kind: "scheduled-nightly-sweep", ...report }, null, 2) + "\n");

// The sweep is INFORMATIONAL (a digest), not an alarm: exit reflects agent health
// only. ok:false (a crash / a guarded-write attempt caught in-agent) => 1, else 0.
process.exit(report.ok ? 0 : 1);
