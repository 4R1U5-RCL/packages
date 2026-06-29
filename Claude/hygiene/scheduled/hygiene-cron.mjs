#!/usr/bin/env node
// hygiene-cron.mjs — THE strong automation layer: the timer-triggered runner.
//
// This is the entry point hygiene is actually FOR. Run on a schedule from the
// host that owns the real ~/.claude, it does the two things that genuinely need
// to happen automatically and unattended:
//
//   1. backup --apply  — writes a fresh, self-VERIFIED archive of the tree. This
//      is the action that must succeed; it drives the alarm (exit) code. A backup
//      that does not verify is an incident.
//   2. cleanup (dry-run drift report) — reports stray files but DOES NOT move
//      them. Moving files is human-gated (it mutates the operator's home tree), so
//      the timer only SURFACES drift; an operator runs `cleanup --apply` after
//      reviewing it. Drift is a maintenance prompt, never the backup alarm —
//      mirroring how audit's scheduled runner keeps matrix-freshness off the
//      security alarm.
//
// It is a thin wrapper over run.mjs — it invokes the same controls/ underneath,
// re-describing nothing. If logic must change, it changes in checks/, not here.
//
//   node scheduled/hygiene-cron.mjs --target ~/.claude
//   node scheduled/hygiene-cron.mjs --config scheduled/hygiene.config.json
//
// The off-system copy reminder (the human-gated P2 step) is surfaced from the
// backup control's own stderr and echoed in the summary.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN = join(HERE, "..", "run.mjs");

function expandHome(p) {
  if (!p) return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}

let target = expandHome(arg("--target", null));
const configPath = arg("--config", null);
if (!target && configPath) {
  try { target = expandHome(JSON.parse(readFileSync(configPath, "utf8")).target); }
  catch (e) { process.stderr.write(`could not read --config ${configPath}: ${e.message}\n`); }
}
if (!target) target = join(homedir(), ".claude");

// Match run.mjs / _fsutil's buffer headroom: a real ~/.claude produces large
// aggregate JSON, and the 1 MB spawnSync default would truncate it → bad parse.
const MAXBUF = 64 * 1024 * 1024;

function dispatch(extraArgs) {
  const r = spawnSync("node", [RUN, "--target", target, ...extraArgs], { encoding: "utf8", maxBuffer: MAXBUF });
  if (r.stderr) process.stderr.write(r.stderr);
  let agg = null;
  try { agg = JSON.parse(r.stdout); } catch { /* */ }
  return { exit: r.status, agg };
}

process.stderr.write(`\n== scheduled hygiene run ==\n  target: ${target}\n`);

// 1. The action that drives the alarm: a verified backup.
process.stderr.write("\n-- backup (--apply: write + re-verify) --\n");
const backup = dispatch(["--only", "backup", "--apply"]);
const bRes = backup.agg?.results?.[0];
const bStatus = bRes?.status ?? "unknown";

// 2. The maintenance prompt: drift report (dry-run, never auto-moves).
process.stderr.write("\n-- cleanup (drift report, dry-run — moves are human-gated) --\n");
const cleanup = dispatch(["--only", "cleanup"]);
const cRes = cleanup.agg?.results?.[0];
const strayCount = cRes?.details?.stray_count ?? null;

process.stderr.write("\n== summary ==\n");
process.stderr.write(`  backup:  ${bStatus.toUpperCase()} — ${bRes?.message ?? ""}\n`);
const driftLine = cRes?.status === "fail"
  ? `${strayCount} stray file(s) — review, then run 'cleanup --apply' (human-gated)`
  : cRes?.status === "pass" ? "tidy (0 stray)" : `could not scan (${cRes?.message ?? "unknown"})`;
process.stderr.write(`  drift:   ${driftLine}\n`);
if (bStatus === "pass") {
  process.stderr.write(`  P2 (human): confirm the archive was copied OFF-SYSTEM (see backup output above).\n`);
}

process.stdout.write(JSON.stringify({
  kind: "scheduled-hygiene", target,
  backup: bStatus, drift: cRes?.status ?? null, stray_count: strayCount,
  archive: bRes?.details?.archive ?? null, results: { backup: bRes, cleanup: cRes },
}, null, 2) + "\n");

// Exit reflects the BACKUP only (the action that must succeed). Drift is reported
// but never sets the alarm code — an operator tidies after reviewing.
if (bStatus === "fail") process.exit(1);
if (bStatus === "unknown") process.exit(2);
process.exit(0);
