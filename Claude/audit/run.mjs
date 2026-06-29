#!/usr/bin/env node
// run.mjs — the dispatcher. Selects checks by surface and aggregates results.
//
// It does NOT contain any check logic (that lives once in checks/). It discovers
// the control set from manifests/*.json, invokes each check as a subprocess,
// parses the one JSON line each emits through _common.mjs, and rolls up a
// summary + an overall exit code. The three entry points (SKILL.md, ci/,
// scheduled/) are thin wrappers over this.
//
//   node run.mjs --surface repo  --target /path/to/repo
//   node run.mjs --surface infra --config infra.config.json
//   node run.mjs --surface all   --target /path/to/repo --config infra.config.json
//
// Repo checks are invoked with `--target <repoRoot>`. Infra checks are
// heterogeneous (a URL, a domain, a secret), so their argv comes from --config:
//
//   { "webhook-auth": { "argv": ["--target","https://...","--secret","$N8N_WEBHOOK_SECRET"] },
//     "dns-auth":     { "argv": ["--domain","tessera-project.dev"] },
//     "matrix-freshness": { "argv": [] } }
//
// `$VARNAME` tokens in argv are expanded from the environment so secrets never
// sit in the config file. An infra check with no config entry cannot be probed,
// so it is reported as `unknown` ("no live config") — honest, never a silent pass.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFESTS = join(HERE, "manifests");
const CHECKS = join(HERE, "checks");

function parseArgs(argv) {
  const o = { surface: "all", target: process.cwd(), config: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--surface") o.surface = argv[++i];
    else if (argv[i] === "--target") o.target = argv[++i];
    else if (argv[i] === "--config") o.config = argv[++i];
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

function expandEnv(argv) {
  return argv.map((a) =>
    typeof a === "string"
      ? a.replace(/^\$([A-Z_][A-Z0-9_]*)$/, (_, v) => process.env[v] ?? "")
      : a);
}

function syntheticUnknown(control, surface, message) {
  // A result that did not run still flows through the same shape.
  return { control, surface, status: "unknown", evidence: message,
           message, negative_control: { injected: false, fired: false, note: "" },
           attack: [], iso27001_2022: [], soc2_cc: [], not_run: true };
}

function runCheck(control, surface, opts, config) {
  const script = join(CHECKS, `${control}.mjs`);
  let argv;
  if (surface === "repo") {
    argv = ["--target", opts.target];
  } else {
    const entry = config?.[control];
    if (!entry || !Array.isArray(entry.argv)) {
      return syntheticUnknown(control, surface,
        `no live config for infra check '${control}' — cannot probe; provide --config`);
    }
    argv = expandEnv(entry.argv);
  }
  const r = spawnSync("node", [script, ...argv], { encoding: "utf8" });
  if (r.error) {
    return syntheticUnknown(control, surface, `failed to spawn check: ${r.error.message}`);
  }
  const line = (r.stdout || "").trim().split("\n").filter(Boolean).pop();
  try {
    return JSON.parse(line);
  } catch {
    return syntheticUnknown(control, surface,
      `check emitted no parseable result (exit ${r.status}); stderr: ${(r.stderr || "").trim().slice(0, 200)}`);
  }
}

function main(argv) {
  const opts = parseArgs(argv);
  let config = null;
  if (opts.config) {
    try { config = JSON.parse(readFileSync(opts.config, "utf8")); }
    catch (e) { process.stderr.write(`could not read --config ${opts.config}: ${e.message}\n`); }
  }

  const controls = discoverControls().filter((c) =>
    opts.surface === "all" ? true : c.surface === opts.surface);

  const results = controls.map((c) => runCheck(c.control, c.surface, opts, config));

  const counts = { pass: 0, fail: 0, unknown: 0 };
  for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;

  // Human summary to stderr; machine aggregate to stdout.
  process.stderr.write(`\naudit — surface=${opts.surface}  target=${opts.target}\n`);
  for (const r of results) {
    const cite = (r.attack || []).map((a) => a.id).join(",") || "—";
    const mark = { pass: "PASS", fail: "FAIL", unknown: "????" }[r.status];
    process.stderr.write(`  [${mark}] ${r.control.padEnd(18)} ${r.surface.padEnd(5)} ${cite}\n` +
                         `         ${r.message || r.evidence || ""}\n`);
  }
  process.stderr.write(`\n  ${counts.pass} pass · ${counts.fail} fail · ${counts.unknown} unknown\n\n`);

  process.stdout.write(JSON.stringify({ surface: opts.surface, target: opts.target,
                                        counts, results }, null, 2) + "\n");

  // Overall exit: any fail => 1; else any unknown => 2; else 0.
  if (counts.fail > 0) return 1;
  if (counts.unknown > 0) return 2;
  return 0;
}

process.exit(main(process.argv.slice(2)));
