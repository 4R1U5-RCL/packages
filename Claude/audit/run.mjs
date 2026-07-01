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
  const o = { surface: "all", reachability: null, target: process.cwd(), config: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--surface") o.surface = argv[++i];
    else if (argv[i] === "--reachability") o.reachability = argv[++i];
    else if (argv[i] === "--target") o.target = argv[++i];
    else if (argv[i] === "--config") o.config = argv[++i];
  }
  return o;
}

// Reachability is the axis the dispatcher keys on. A manifest may declare it
// explicitly (app checks do: "static"/"dynamic"); when absent we default so the
// original checks are unchanged — infra→dynamic (probe a live endpoint via
// --config), everything else→static (read source via --target).
function defaultReachability(surface) {
  return surface === "infra" ? "dynamic" : "static";
}

function discoverControls() {
  const out = [];
  for (const f of readdirSync(MANIFESTS)) {
    if (!f.endsWith(".json")) continue;
    try {
      const m = JSON.parse(readFileSync(join(MANIFESTS, f), "utf8"));
      if (m.control && m.surface) {
        out.push({ control: m.control, surface: m.surface,
                   reachability: m.reachability ?? defaultReachability(m.surface) });
      }
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

function syntheticUnknown(control, surface, reachability, message) {
  // A result that did not run still flows through the same shape.
  return { control, surface, reachability, status: "unknown", evidence: message,
           message, negative_control: { injected: false, fired: false, note: "" },
           attack: [], iso27001_2022: [], soc2_cc: [], not_run: true };
}

function runCheck(control, surface, reachability, opts, config) {
  const script = join(CHECKS, `${control}.mjs`);
  let argv;
  if (reachability === "static") {
    // Source-reachable: read the checkout. Covers repo checks and app:static.
    argv = ["--target", opts.target];
  } else {
    // Dynamic: probe a live endpoint. Covers infra checks and app:dynamic. Its
    // heterogeneous argv (a URL, a domain, a state fixture) comes from --config;
    // with no entry the control cannot be probed → honest unknown, never a pass.
    const entry = config?.[control];
    if (!entry || !Array.isArray(entry.argv)) {
      return syntheticUnknown(control, surface, reachability,
        `no live config for dynamic check '${control}' — cannot probe; provide --config`);
    }
    argv = expandEnv(entry.argv);
  }
  const r = spawnSync("node", [script, ...argv], { encoding: "utf8" });
  if (r.error) {
    return syntheticUnknown(control, surface, reachability, `failed to spawn check: ${r.error.message}`);
  }
  const line = (r.stdout || "").trim().split("\n").filter(Boolean).pop();
  try {
    return JSON.parse(line);
  } catch {
    return syntheticUnknown(control, surface, reachability,
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

  // Selection composes two independent filters: --surface (all|repo|infra|app)
  // and the optional --reachability (static|dynamic). The CI gate selects
  // `--reachability static` to get repo + app:static in one pass; the scheduled
  // runner selects `--surface infra`; the agent run selects `--surface all`.
  const controls = discoverControls()
    .filter((c) => opts.surface === "all" || c.surface === opts.surface)
    .filter((c) => !opts.reachability || c.reachability === opts.reachability);

  const results = controls.map((c) => runCheck(c.control, c.surface, c.reachability, opts, config));

  const counts = { pass: 0, fail: 0, unknown: 0 };
  for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;

  // Human summary to stderr; machine aggregate to stdout.
  const reachTag = opts.reachability ? `  reachability=${opts.reachability}` : "";
  process.stderr.write(`\naudit — surface=${opts.surface}${reachTag}  target=${opts.target}\n`);
  for (const r of results) {
    const cite = (r.attack || []).map((a) => a.id).join(",") || "—";
    const mark = { pass: "PASS", fail: "FAIL", unknown: "????" }[r.status];
    const surf = r.reachability ? `${r.surface}:${r.reachability[0]}` : r.surface; // e.g. app:s / app:d
    process.stderr.write(`  [${mark}] ${r.control.padEnd(18)} ${surf.padEnd(7)} ${cite}\n` +
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
