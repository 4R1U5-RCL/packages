#!/usr/bin/env node
// run.mjs — the dispatcher. Discovers controls from manifests, runs them against
// a target tree, and aggregates results + an overall exit code.
//
// It contains NO control logic (that lives once in checks/). It reads the control
// set from manifests/*.json, invokes each control as a subprocess with --target
// (and --apply when asked), parses the one JSON line each emits through
// _common.mjs, and rolls up a summary. The three entry points (SKILL.md, ci/,
// scheduled/) are thin wrappers over this.
//
//   node run.mjs --target ~/.claude                 # dry-run both controls
//   node run.mjs --only cleanup --target ~/.claude  # one control
//   node run.mjs --only backup  --target ~/.claude --apply   # mutating
//   node run.mjs --self-test                        # run every control's self-guard
//
// Default target is ~/.claude (the IOPHON home tree). A leading ~ is expanded
// from the host home dir.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFESTS = join(HERE, "manifests");
const CHECKS = join(HERE, "checks");

function expandHome(p) {
  if (!p) return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function parseArgs(argv) {
  const o = { target: join(homedir(), ".claude"), only: null, apply: false, selfTest: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--target") o.target = expandHome(argv[++i]);
    else if (argv[i] === "--only") o.only = argv[++i];
    else if (argv[i] === "--apply") o.apply = true;
    else if (argv[i] === "--self-test") o.selfTest = true;
  }
  return o;
}

function discoverControls() {
  const out = [];
  for (const f of readdirSync(MANIFESTS)) {
    if (!f.endsWith(".json")) continue;
    try {
      const m = JSON.parse(readFileSync(join(MANIFESTS, f), "utf8"));
      if (m.control && m.surface) out.push({ control: m.control, surface: m.surface });
    } catch { /* skip malformed manifest */ }
  }
  return out.sort((a, b) => a.control.localeCompare(b.control));
}

function syntheticUnknown(control, surface, message) {
  return { control, surface, status: "unknown", evidence: message, message,
           negative_control: { injected: false, fired: false, note: "" },
           details: {}, not_run: true };
}

function runCheck(control, surface, opts) {
  const script = join(CHECKS, `${control}.mjs`);
  const argv = ["--target", opts.target];
  if (opts.apply) argv.push("--apply");
  const r = spawnSync("node", [script, ...argv], { encoding: "utf8" });
  // controls print the off-system reminder / diagnostics on stderr; surface it.
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.error) return syntheticUnknown(control, surface, `failed to spawn control: ${r.error.message}`);
  const line = (r.stdout || "").trim().split("\n").filter(Boolean).pop();
  try { return JSON.parse(line); }
  catch {
    return syntheticUnknown(control, surface,
      `control emitted no parseable result (exit ${r.status})`);
  }
}

function runSelfTest(control) {
  const r = spawnSync("node", [join(CHECKS, `${control}.mjs`), "--self-test"], { encoding: "utf8" });
  let obj = null;
  try { obj = JSON.parse((r.stdout || "").trim().split("\n").filter(Boolean).pop()); } catch { /* */ }
  return { control, ok: obj?.self_guard_ok === true, exit: r.status, note: obj?.note ?? "" };
}

function main(argv) {
  const opts = parseArgs(argv);
  let controls = discoverControls();
  if (opts.only) controls = controls.filter((c) => c.control === opts.only);
  if (controls.length === 0) {
    process.stderr.write(`no controls matched (--only ${opts.only ?? "—"})\n`);
    return 2;
  }

  if (opts.selfTest) {
    const rows = controls.map((c) => runSelfTest(c.control));
    process.stderr.write(`\nhygiene — self-test (negative controls)\n`);
    for (const r of rows) {
      process.stderr.write(`  [${r.ok ? "OK  " : "XX  "}] ${r.control.padEnd(10)} ${r.note}\n`);
    }
    const allOk = rows.every((r) => r.ok);
    process.stdout.write(JSON.stringify({ mode: "self-test", all_ok: allOk, rows }, null, 2) + "\n");
    return allOk ? 0 : 2;
  }

  const results = controls.map((c) => runCheck(c.control, c.surface, opts));
  const counts = { pass: 0, fail: 0, unknown: 0 };
  for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;

  // Human summary to stderr; machine aggregate to stdout.
  process.stderr.write(`\nhygiene — target=${opts.target}${opts.apply ? "  (APPLY)" : "  (dry-run)"}\n`);
  for (const r of results) {
    const mark = { pass: "PASS", fail: "FAIL", unknown: "????" }[r.status];
    process.stderr.write(`  [${mark}] ${r.control.padEnd(10)} ${r.surface.padEnd(5)}\n` +
                         `         ${r.message || r.evidence || ""}\n`);
  }
  process.stderr.write(`\n  ${counts.pass} pass · ${counts.fail} fail · ${counts.unknown} unknown\n\n`);

  process.stdout.write(JSON.stringify({ target: opts.target, apply: opts.apply, counts, results }, null, 2) + "\n");

  if (counts.fail > 0) return 1;
  if (counts.unknown > 0) return 2;
  return 0;
}

process.exit(main(process.argv.slice(2)));
