#!/usr/bin/env node
// run.mjs — the dispatcher. Runs the hygiene controls (cleanup, backup) against a
// target tree under a chosen PROFILE, and aggregates results + an overall exit code.
//
// It contains NO control logic (that lives once in checks/). It invokes each
// control as a subprocess with --target and --profile (and --apply when asked),
// parses the one JSON line each emits through _common.mjs, and rolls up a summary.
// The three entry points (SKILL.md, ci/, scheduled/) are thin wrappers over this.
//
//   node run.mjs --target ~/.claude                          # both controls, claude profile
//   node run.mjs --profile codebase --target /path/to/repo   # codebase profile (report-only cleanup)
//   node run.mjs --profile llm-artifacts --target ~/.claude/projects
//   node run.mjs --only cleanup --target DIR                 # one control
//   node run.mjs --only backup  --target DIR --apply         # mutating (writes archive)
//   node run.mjs --self-test [--profile ...]                 # run every control's self-guard
//
// Profiles live in profiles/<name>.json (claude | codebase | llm-artifacts). Default
// is `claude` (full back-compat with v0.2.1). The default target comes from the
// profile's target_default; a leading ~ is expanded from the host home dir.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKS = join(HERE, "checks");
const PROFILES = join(HERE, "profiles");

// A real tree makes a control's JSON line large (cleanup's drift report ran ~935 KB
// on ~/.claude). spawnSync's default 1 MB buffer silently truncates past that → the
// JSON won't parse → a false `unknown`. Give the child generous headroom.
const MAXBUF = 64 * 1024 * 1024;

// Fixed control set — the configurable axis is now the PROFILE, not the manifest set.
const CONTROLS = ["backup", "cleanup"];

function expandHome(p) {
  if (!p) return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function loadProfile(name) {
  return JSON.parse(readFileSync(join(PROFILES, `${name}.json`), "utf8"));
}

function parseArgs(argv) {
  const o = { target: null, profile: "claude", only: null, apply: false, selfTest: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--target") o.target = expandHome(argv[++i]);
    else if (argv[i] === "--profile") o.profile = argv[++i];
    else if (argv[i] === "--only") o.only = argv[++i];
    else if (argv[i] === "--apply") o.apply = true;
    else if (argv[i] === "--self-test") o.selfTest = true;
  }
  return o;
}

function syntheticUnknown(control, message) {
  return { control, surface: "local", status: "unknown", evidence: message, message,
           negative_control: { injected: false, fired: false, note: "" }, details: {}, not_run: true };
}

function runCheck(control, opts) {
  const argv = ["--target", opts.target, "--profile", opts.profile];
  if (opts.apply) argv.push("--apply");
  const r = spawnSync("node", [join(CHECKS, `${control}.mjs`), ...argv], { encoding: "utf8", maxBuffer: MAXBUF });
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.error) return syntheticUnknown(control, `failed to spawn control: ${r.error.message}`);
  const line = (r.stdout || "").trim().split("\n").filter(Boolean).pop();
  try { return JSON.parse(line); }
  catch { return syntheticUnknown(control, `control emitted no parseable result (exit ${r.status})`); }
}

function runSelfTest(control, profile) {
  const r = spawnSync("node", [join(CHECKS, `${control}.mjs`), "--self-test", "--profile", profile], { encoding: "utf8", maxBuffer: MAXBUF });
  let obj = null;
  try { obj = JSON.parse((r.stdout || "").trim().split("\n").filter(Boolean).pop()); } catch { /* */ }
  return { control, ok: obj?.self_guard_ok === true, exit: r.status, note: obj?.note ?? "" };
}

function main(argv) {
  const opts = parseArgs(argv);
  let profile;
  try { profile = loadProfile(opts.profile); }
  catch (e) { process.stderr.write(`unknown profile '${opts.profile}': ${e.message}\n`); return 2; }
  if (!opts.target) opts.target = expandHome(profile.target_default || ".");

  let controls = CONTROLS.slice();
  if (opts.only) controls = controls.filter((c) => c === opts.only);
  if (controls.length === 0) { process.stderr.write(`no controls matched (--only ${opts.only ?? "—"})\n`); return 2; }

  if (opts.selfTest) {
    const rows = controls.map((c) => runSelfTest(c, opts.profile));
    process.stderr.write(`\nhygiene — self-test (profile: ${opts.profile}, negative controls)\n`);
    for (const r of rows) process.stderr.write(`  [${r.ok ? "OK  " : "XX  "}] ${r.control.padEnd(10)} ${r.note}\n`);
    const allOk = rows.every((r) => r.ok);
    process.stdout.write(JSON.stringify({ mode: "self-test", profile: opts.profile, all_ok: allOk, rows }, null, 2) + "\n");
    return allOk ? 0 : 2;
  }

  const results = controls.map((c) => runCheck(c, opts));
  const counts = { pass: 0, fail: 0, unknown: 0 };
  for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;

  process.stderr.write(`\nhygiene — profile=${opts.profile} target=${opts.target}${opts.apply ? "  (APPLY)" : "  (dry-run)"}\n`);
  for (const r of results) {
    const mark = { pass: "PASS", fail: "FAIL", unknown: "????" }[r.status];
    process.stderr.write(`  [${mark}] ${r.control.padEnd(10)}\n         ${r.message || r.evidence || ""}\n`);
  }
  process.stderr.write(`\n  ${counts.pass} pass · ${counts.fail} fail · ${counts.unknown} unknown\n\n`);

  process.stdout.write(JSON.stringify({ profile: opts.profile, target: opts.target, apply: opts.apply, counts, results }, null, 2) + "\n");

  if (counts.fail > 0) return 1;
  if (counts.unknown > 0) return 2;
  return 0;
}

process.exit(main(process.argv.slice(2)));
