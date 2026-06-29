#!/usr/bin/env node
// demo.mjs — the demonstration run / regression backstop (offline, no live key).
//
// For EVERY flow it asserts the orchestration invariants that make consult
// honest, running the SAME flow scripts (and SAME lib/_chain.mjs path) against
// the bundled RECORDED fixtures:
//
//   1. --self-test                => orchestration self-guard PASS (status=pass)
//   2. agreement / clean fixture  => the "good" path (HIGH / no-escalation), pass
//   3. divergence / risks fixture => the negative control FIRES
//        research: confidence LOW with BOTH positions surfaced
//        validate: escalation to the revalidator actually triggers
//      and the self-guard recorded the control as injected AND fired
//   4. malformed / unreachable    => verdict unknown (a dead tier is NEVER
//        counted as corroboration, NEVER fabricated into an answer)
//
// Then an offline E-round: run.mjs --self-test must aggregate all flows green —
// proving the dispatcher layer introduces no false pass.
//
// Exit 0 only if every assertion holds. Deliberately breaking an invariant
// fixture (e.g. dropping the risks fixture below the escalation threshold) MUST
// make this exit non-zero — that is the whole point of the backstop.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PKG = dirname(fileURLToPath(import.meta.url));
const node = process.execPath;

function flow(name, args) {
  const r = spawnSync(node, [join(PKG, "flows", `${name}.mjs`), ...args],
                      { cwd: PKG, encoding: "utf8" });
  const line = (r.stdout || "").trim().split("\n").filter(Boolean).pop();
  let obj = null; try { obj = JSON.parse(line); } catch { /* leave null */ }
  return { exit: r.status, obj };
}

// label -> assertion over the emitted Result object.
const CASES = {
  research: {
    selfTest: (o) => o && o.status === "pass" &&
      o.negative_control.injected === true && o.negative_control.fired === true,
    scenarios: [
      { label: "agree => HIGH",            args: ["--fixtures", "fixtures/research/agree"],
        ok: (o) => o.status === "pass" && o.confidence === "HIGH" && o.corroborated === true && o.verdict === "validated" },
      { label: "diverge => LOW + both",    args: ["--fixtures", "fixtures/research/disagree"],
        ok: (o) => o.status === "pass" && o.confidence === "LOW" && o.corroborated === false && (o.positions || []).length >= 2 },
      { label: "dead corrob => unknown",   args: ["--fixtures", "fixtures/malformed/corroborators-empty"],
        ok: (o) => o.status === "unknown" && o.verdict === "unknown" && o.confidence === null },
      { label: "unreachable base => unknown", args: ["--fixtures", "fixtures/malformed/base-unreachable"],
        ok: (o) => o.status === "unknown" && o.verdict === "unknown" && o.confidence === null },
    ],
  },
  validate: {
    selfTest: (o) => o && o.status === "pass" &&
      o.negative_control.injected === true && o.negative_control.fired === true,
    scenarios: [
      { label: "risks => ESCALATES",       args: ["--fixtures", "fixtures/validate/risks"],
        ok: (o) => o.status === "pass" && o.escalated === true && o.tiers.some((t) => t.role === "revalidator" && t.responded) },
      { label: "clean => no escalation",   args: ["--fixtures", "fixtures/validate/clean"],
        ok: (o) => o.status === "pass" && o.escalated === false },
      { label: "dead validator => unknown", args: ["--fixtures", "fixtures/malformed/corroborators-empty"],
        ok: (o) => o.status === "unknown" && o.verdict === "unknown" && o.confidence === null },
      { label: "unreachable base => unknown", args: ["--fixtures", "fixtures/malformed/base-unreachable"],
        ok: (o) => o.status === "unknown" && o.verdict === "unknown" && o.confidence === null },
    ],
  },
};

function mark(b) { return b ? "ok " : "XX "; }

let allPass = true;
process.stderr.write("\n=== demonstration: every flow watched to fire its negative control ===\n\n");

for (const [name, spec] of Object.entries(CASES)) {
  const st = flow(name, ["--self-test"]);
  const stOk = spec.selfTest(st.obj);
  if (!stOk) allPass = false;
  process.stderr.write(`  ${name}\n`);
  process.stderr.write(`    self-test (orchestration self-guard) .......... ${mark(stOk)}` +
                       `${st.obj ? `[${st.obj.status}] ` + (st.obj.message || "") : "(no result)"}\n`);
  for (const sc of spec.scenarios) {
    const res = flow(name, sc.args);
    const ok = res.obj && sc.ok(res.obj);
    if (!ok) allPass = false;
    const detail = res.obj
      ? `[${res.obj.status}] confidence=${res.obj.confidence} verdict=${res.obj.verdict}` +
        (res.obj.escalated !== null ? ` escalated=${res.obj.escalated}` : "")
      : "(no result)";
    process.stderr.write(`    ${sc.label.padEnd(26)} .......... ${mark(ok)}${detail}\n`);
  }
  process.stderr.write("\n");
}

// E-round: the dispatcher must not introduce a false pass on the offline suite.
process.stderr.write("=== E-round: offline dispatch (run.mjs --self-test) ===\n");
const er = spawnSync(node, [join(PKG, "run.mjs"), "--self-test"], { cwd: PKG, encoding: "utf8" });
process.stderr.write(er.stderr || "");
let erObj = null; try { erObj = JSON.parse(er.stdout); } catch { /* */ }
const erOk = erObj && erObj.counts.fail === 0 && erObj.counts.unknown === 0 && er.status === 0;
if (!erOk) allPass = false;

process.stderr.write(`\n${allPass ? "DEMONSTRATION PASSED" : "DEMONSTRATION FAILED"}: ` +
  `orchestration invariants ${allPass ? "hold" : "REGRESSED"}; ` +
  `offline dispatch ${erOk ? "clean" : "REGRESSED"}.\n\n`);

process.exit(allPass ? 0 : 1);
