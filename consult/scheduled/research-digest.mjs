#!/usr/bin/env node
// research-digest.mjs — OPTIONAL timer example (the WEAKER-FIT entry point).
//
// BE HONEST: consult is REQUEST-DRIVEN. There is no standing thing to watch on a
// schedule the way audit watches infra drift — the natural trigger for a cross-
// model consult is a human asking a question or proposing a plan. This wrapper
// exists for the one genuine recurring case: a standing research question whose
// answer you want re-run through the chain on a cadence (e.g. a weekly "what
// changed in X" digest). Do not read it as consult's primary surface; the
// primary surfaces are the agent (SKILL.md) and the CI gate (ci/).
//
// It is a thin wrapper over run.mjs — no chain logic here. It reads a config
// listing standing question(s), runs each through the research flow live, and
// emits an aggregate. A run where a tier could not be reached/parsed comes back
// `unknown` (never a fabricated answer), exactly as on any other run.
//
//   node scheduled/research-digest.mjs --config scheduled/consult.config.json
//
// Credentials: the LiteLLM proxy URL + key come from the host environment
// ($LITELLM_BASE_URL / $LITELLM_API_KEY), never the config, never a log.
// Perplexity web fact-check is OFF unless a question opts in (factcheck:true) —
// an unattended job reaching the external web is a deliberate choice, not a default.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN = join(HERE, "..", "run.mjs");

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}

const configPath = arg("--config", join(HERE, "consult.config.json"));
let config;
try { config = JSON.parse(readFileSync(configPath, "utf8")); }
catch (e) {
  process.stderr.write(`research-digest: could not read --config ${configPath}: ${e.message}\n`);
  process.exit(2);
}

const questions = Array.isArray(config.questions) ? config.questions : [];
if (questions.length === 0) {
  process.stderr.write("research-digest: config has no questions[] — nothing to run\n");
  process.exit(2);
}

const results = [];
for (const q of questions) {
  const argv = [RUN, "--flow", "research", "--question", String(q.question)];
  if (q.factcheck === true) argv.push("--factcheck"); // explicit external-web opt-in
  if (q.report) argv.push("--report", q.report);
  const r = spawnSync("node", argv, { encoding: "utf8" });
  if (r.stderr) process.stderr.write(r.stderr);
  let agg = null; try { agg = JSON.parse(r.stdout); } catch { /* */ }
  const res = agg?.results?.[0] ?? { flow: "research", status: "unknown",
    message: "no parseable result", confidence: null };
  results.push({ question: q.question, status: res.status,
    confidence: res.confidence, verdict: res.verdict });
}

const counts = results.reduce((a, x) => (a[x.status] = (a[x.status] ?? 0) + 1, a),
                              { pass: 0, fail: 0, unknown: 0 });

process.stderr.write("\n== scheduled research digest ==\n");
for (const r of results) {
  process.stderr.write(`  [${r.status}] confidence=${r.confidence ?? "n/a"} — ${r.question}\n`);
}
process.stderr.write(`\n  ${counts.pass} pass · ${counts.fail} fail · ${counts.unknown} unknown\n` +
                     `  (confidence = inter-model agreement, NOT correctness)\n\n`);

process.stdout.write(JSON.stringify({ kind: "scheduled-research-digest", counts, results }, null, 2) + "\n");

if (counts.fail > 0) process.exit(1);
if (counts.unknown > 0) process.exit(2);
process.exit(0);
