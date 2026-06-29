#!/usr/bin/env node
// run.mjs — the dispatcher. Discovers flows from manifests/ and runs them.
//
// It contains NO chain logic (that lives once in lib/_chain.mjs). It discovers
// the flow set from manifests/*.json, invokes each flow script as a subprocess,
// parses the one JSON line each emits through lib/_common.mjs, and rolls up a
// summary + an overall exit code. The three entry points (SKILL.md, ci/,
// scheduled/) are thin wrappers over this.
//
//   node run.mjs --self-test                                  # OFFLINE: all flows' orchestration self-tests (no key)
//   node run.mjs --flow research --question "..." [--factcheck] [--report out.md]
//   node run.mjs --flow validate --plan-file plan.txt [--factcheck] [--report out.md]
//   node run.mjs --flow research --fixtures fixtures/research/agree     # offline scenario inspection
//
// The live flow modes call the LiteLLM proxy (lib/_proxy.mjs) using
// $LITELLM_BASE_URL / $LITELLM_API_KEY from the environment — never written to a
// file, never logged. A tier that can't be reached/parsed => verdict unknown,
// never a fabricated cross-validated answer.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFESTS = join(HERE, "manifests");
const FLOWS = join(HERE, "flows");

function parseArgs(argv) {
  const o = { selfTest: false, flow: null, passthrough: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--self-test") o.selfTest = true;
    else if (a === "--flow") o.flow = argv[++i];
    else o.passthrough.push(a);
  }
  return o;
}

function discoverFlows() {
  const out = [];
  for (const f of readdirSync(MANIFESTS)) {
    if (!f.endsWith(".json")) continue;
    try {
      const m = JSON.parse(readFileSync(join(MANIFESTS, f), "utf8"));
      if (m.flow) out.push(m.flow);
    } catch { /* skip malformed manifest */ }
  }
  return [...new Set(out)].sort();
}

function syntheticUnknown(flow, message) {
  return { flow, status: "unknown", confidence: null, corroborated: false,
           verdict: null, escalated: null, tiers: [], positions: [], risk_count: null,
           evidence: message, message,
           negative_control: { injected: false, fired: false, note: "" }, not_run: true };
}

function runFlow(flow, argv) {
  const script = join(FLOWS, `${flow}.mjs`);
  // Inherit stdin so a piped base answer reaches the flow (Claude is the base
  // tier — the agent may pipe its own answer in). stdout/stderr stay captured.
  const r = spawnSync("node", [script, ...argv], { encoding: "utf8", stdio: ["inherit", "pipe", "pipe"] });
  if (r.error) return syntheticUnknown(flow, `failed to spawn flow: ${r.error.message}`);
  const line = (r.stdout || "").trim().split("\n").filter(Boolean).pop();
  try { return JSON.parse(line); }
  catch {
    return syntheticUnknown(flow,
      `flow emitted no parseable result (exit ${r.status}); stderr: ${(r.stderr || "").trim().slice(0, 200)}`);
  }
}

function summarize(label, results) {
  const counts = { pass: 0, fail: 0, unknown: 0 };
  for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;

  process.stderr.write(`\nconsult — ${label}\n`);
  for (const r of results) {
    const mark = { pass: "PASS", fail: "FAIL", unknown: "????" }[r.status];
    const conf = r.confidence ? `confidence=${r.confidence}` : "";
    const esc = r.escalated === true ? "escalated" : (r.escalated === false ? "no-escalate" : "");
    process.stderr.write(`  [${mark}] ${String(r.flow).padEnd(10)} ${conf} ${esc}\n` +
                         `         ${r.message || r.evidence || ""}\n`);
  }
  process.stderr.write(`\n  ${counts.pass} pass · ${counts.fail} fail · ${counts.unknown} unknown\n\n`);

  process.stdout.write(JSON.stringify({ mode: label, counts, results }, null, 2) + "\n");
  if (counts.fail > 0) return 1;
  if (counts.unknown > 0) return 2;
  return 0;
}

function main(argv) {
  const opts = parseArgs(argv);

  if (opts.selfTest) {
    // OFFLINE orchestration self-tests for EVERY flow. No live models, no secrets.
    const flows = discoverFlows();
    const results = flows.map((f) => runFlow(f, ["--self-test"]));
    return summarize("self-test (offline orchestration invariants)", results);
  }

  if (!opts.flow) {
    process.stderr.write("usage: run.mjs --self-test | --flow <research|validate> [flow args]\n");
    return 64;
  }
  if (!discoverFlows().includes(opts.flow)) {
    process.stderr.write(`unknown flow '${opts.flow}'; known: ${discoverFlows().join(", ")}\n`);
    return 64;
  }
  const result = runFlow(opts.flow, opts.passthrough);
  return summarize(`flow=${opts.flow}`, [result]);
}

process.exit(main(process.argv.slice(2)));
