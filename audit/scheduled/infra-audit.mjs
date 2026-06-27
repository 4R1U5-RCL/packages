#!/usr/bin/env node
// infra-audit.mjs — LAYER 2c: the scheduled infra audit (timer-triggered).
//
// Runs the INFRA subset of checks + the matrix-freshness meta-control on a
// schedule, from a host that holds the infra credentials CI deliberately cannot.
// It closes the gap the other two layers leave: the CI gate can't reach infra,
// and the agent run is on-demand — so without this nothing AUTOMATICALLY catches
// an infra control regressing (an exposed n8n key, egress isolation silently
// dropped) or the ATT&CK matrix going stale.
//
// It is a plain scheduled job that invokes run.mjs directly (sufficient while the
// infra probes are stable). If the probes ever need agent adaptation, swap to a
// cron-triggered SKILL.md run instead — same checks/ underneath.
//
//   node scheduled/infra-audit.mjs --config scheduled/infra.config.json
//
// Credentials: argv in the config uses `$ENV_VAR` tokens that run.mjs expands
// from the host environment, so no secret sits in the config file. This host
// holds infra creds; treat any key seen in a log as burned and rotate it.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN = join(HERE, "..", "run.mjs");

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}

const config = arg("--config", join(HERE, "infra.config.json"));

const r = spawnSync("node", [RUN, "--surface", "infra", "--config", config],
                    { encoding: "utf8" });
// run.mjs prints the human summary on stderr; surface it.
if (r.stderr) process.stderr.write(r.stderr);

let agg;
try { agg = JSON.parse(r.stdout); }
catch {
  process.stderr.write("infra-audit: run.mjs produced no parseable aggregate\n");
  process.exit(2);
}

// Separate the security controls from the matrix-freshness MAINTENANCE control:
// a stale matrix is a "review & re-map" prompt, NOT an infra-security regression,
// so it must not masquerade as a security alarm (nor be a deploy gate).
const security = agg.results.filter((x) => x.control !== "matrix-freshness");
const freshness = agg.results.find((x) => x.control === "matrix-freshness");

const secCounts = security.reduce((a, x) => (a[x.status]++, a),
                                  { pass: 0, fail: 0, unknown: 0 });

process.stderr.write("\n== scheduled infra audit ==\n");
process.stderr.write(`security controls: ${secCounts.pass} pass · ` +
                     `${secCounts.fail} fail · ${secCounts.unknown} unknown\n`);
if (freshness) {
  const tag = { pass: "current", fail: "STALE — review & re-map (maintenance, not a block)",
                unknown: "could not verify" }[freshness.status];
  process.stderr.write(`matrix freshness: ${tag}\n  ${freshness.message || ""}\n`);
}

// Machine aggregate to stdout for an alerting wrapper to consume.
process.stdout.write(JSON.stringify({ kind: "scheduled-infra-audit",
  security: secCounts, freshness: freshness?.status ?? null, results: agg.results }, null, 2) + "\n");

// Exit reflects SECURITY controls only: any fail => 1, any unknown => 2, else 0.
// Freshness is reported but never sets the alarm code.
if (secCounts.fail > 0) process.exit(1);
if (secCounts.unknown > 0) process.exit(2);
process.exit(0);
