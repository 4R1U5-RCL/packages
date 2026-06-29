#!/usr/bin/env node
// validate.mjs — FLOW: validate   (thin caller over lib/_chain.mjs)
//
// Cross-validate a plan/proposal: base summary -> validator finds risks ->
// ESCALATE to the revalidator when the validator raises >= threshold (3)
// substantive risks OR expresses uncertainty (+ optional consented Perplexity
// fact-check). All orchestration lives in lib/_chain.mjs — this file only wires
// inputs, self-guards, and emits.
//
// SHAPE — mirrors audit/checks/rls.mjs:
//   1. Read the FIXED manifest (manifests/validate.json) — the escalation
//      threshold (>=3 risks) is declared there, not chosen per run.
//   2. SELF-GUARD FIRST against RECORDED fixtures, running the SAME runValidate()
//      path used live:
//        - validate/risks  (validator raises >=3 risks) MUST escalate to the
//          revalidator (the escalation negative control FIRES),
//        - validate/clean  (<3 risks, no uncertainty) MUST NOT escalate
//          (false-positive guard),
//        - malformed/corroborators-empty (validator dead) MUST yield unknown,
//        - malformed/base-unreachable MUST yield unknown (never fabricated).
//      A violated firing invariant => fail; a fixture that cannot be exercised
//      => unknown. NEVER a silent pass.
//   3. Only with a fired negative control do we trust a live/scenario run.
//
// Run:  node flows/validate.mjs --self-test
//       node flows/validate.mjs --fixtures fixtures/validate/risks       (offline scenario)
//       node flows/validate.mjs --plan "..." [--factcheck] [--report out.md]   (live proxy)
//       node flows/validate.mjs --plan-file plan.txt                     (live proxy)

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";
import { Result, emitResult } from "../lib/_common.mjs";
import { runValidate, makeFixtureCallModel } from "../lib/_chain.mjs";
import { makeProxyCallModel } from "../lib/_proxy.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const MANIFEST = join(PKG, "manifests", "validate.json");
const FIX = join(PKG, "fixtures");
const FLOW = "validate";

function loadManifest() { return JSON.parse(readFileSync(MANIFEST, "utf8")); }

async function selfGuard() {
  const m = loadManifest();
  const threshold = m.escalation?.risk_threshold ?? 3;
  let risky, clean, corrEmpty, baseUnreach;
  try {
    risky = await runValidate({ plan: "self-guard", manifest: m,
      callModel: makeFixtureCallModel(join(FIX, "validate", "risks"), m) });
    clean = await runValidate({ plan: "self-guard", manifest: m,
      callModel: makeFixtureCallModel(join(FIX, "validate", "clean"), m) });
    corrEmpty = await runValidate({ plan: "self-guard", manifest: m,
      callModel: makeFixtureCallModel(join(FIX, "malformed", "corroborators-empty"), m) });
    baseUnreach = await runValidate({ plan: "self-guard", manifest: m,
      callModel: makeFixtureCallModel(join(FIX, "malformed", "base-unreachable"), m) });
  } catch (e) {
    return { ok: false, regressed: false, injected: false, fired: false,
             note: `fixtures unreadable: ${e.message}` };
  }

  // injected: the risks fixture provably carries >= threshold substantive risks
  // (the bad input is really present, not an empty scan).
  const injected = typeof risky.riskCount === "number" && risky.riskCount >= threshold;
  // fired: escalation actually triggered on the risky plan.
  const fired = risky.escalated === true &&
    risky.tiers.some((t) => t.role === "revalidator" && t.responded);
  // false-positive guard: a clean plan must NOT escalate.
  const cleanGuard = clean.escalated === false &&
    !clean.tiers.some((t) => t.role === "revalidator" && t.responded);
  // honest-corroboration guards.
  const corrGuard = corrEmpty.verdict === "unknown" && corrEmpty.confidence === null;
  const unreachGuard = baseUnreach.verdict === "unknown" && baseUnreach.confidence === null;

  if (!injected) return { ok: false, regressed: false, injected, fired,
    note: `self-guard FAILED: risks fixture parsed ${risky.riskCount} risk(s) (< threshold ` +
          `${threshold}) — the escalation negative control could not be injected` };
  if (!fired) return { ok: false, regressed: true, injected, fired,
    note: `self-guard REGRESSED: validator raised ${risky.riskCount} risk(s) (>= ${threshold}) ` +
          `but escalation did NOT fire (escalated=${risky.escalated}) — the core invariant is broken` };
  if (!cleanGuard) return { ok: false, regressed: true, injected, fired,
    note: `self-guard REGRESSED: clean plan escalated (escalated=${clean.escalated}) — false-positive escalation` };
  if (!corrGuard) return { ok: false, regressed: true, injected, fired,
    note: `self-guard REGRESSED: dead validator did not yield unknown ` +
          `(got ${corrEmpty.verdict}/${corrEmpty.confidence})` };
  if (!unreachGuard) return { ok: false, regressed: true, injected, fired,
    note: `self-guard REGRESSED: unreachable base did not yield unknown ` +
          `(got ${baseUnreach.verdict}/${baseUnreach.confidence})` };
  return { ok: true, regressed: false, injected, fired,
    note: `self-guard OK: ${risky.riskCount} risks => ESCALATED to revalidator; ` +
          `clean plan did NOT escalate; dead/unreachable tiers => unknown` };
}

function selfGuardResult(sg) {
  const r = new Result(FLOW);
  r.negativeControl({ injected: sg.injected, fired: sg.fired, note: sg.note });
  if (sg.regressed) return r.set("fail", { evidence: sg.note,
    message: "validate orchestration invariant violated (escalation regressed)" });
  if (!sg.ok) return r.set("unknown", { evidence: sg.note,
    message: "validate self-guard could not be exercised — verdict not trustworthy" });
  return r.set("pass", { evidence: sg.note,
    message: "validate orchestration self-guard fired (escalation invariant holds)" });
}

function renderReport(v) {
  const lines = [];
  lines.push(`# validate report`);
  lines.push(``);
  lines.push(`> CONFIDENCE is INTER-MODEL AGREEMENT, not a claim of correctness.`);
  lines.push(``);
  lines.push(`- **verdict:** ${v.verdict}  (escalated: ${v.escalated})`);
  lines.push(`- **confidence:** ${v.confidence ?? "n/a"}  (corroborated: ${v.corroborated})`);
  lines.push(`- **risks raised:** ${v.riskCount ?? "n/a"}`);
  lines.push(``);
  lines.push(`## risks & re-assessment`);
  for (const p of (v.positions || [])) {
    lines.push(`### ${p.tier} (${p.model}${p.stance ? `, ${p.stance}` : ""})`);
    for (const rk of (p.risks || [])) lines.push(`- RISK: ${rk}`);
    for (const rk of (p.added_risks || [])) lines.push(`- RISK (added): ${rk}`);
  }
  lines.push(``);
  lines.push(`## tiers`);
  for (const t of v.tiers) {
    lines.push(`- \`${t.role}\` (${t.model}): responded=${t.responded}` +
               `${t.optionalSkipped ? " [skipped]" : ""}${t.error ? `, ${t.error}` : ""}`);
  }
  if (v.downgrade_note) { lines.push(``); lines.push(`> ${v.downgrade_note}`); }
  return lines.join("\n") + "\n";
}

async function run(opts) {
  const m = loadManifest();
  const sg = await selfGuard();
  const r = new Result(FLOW);
  r.negativeControl({ injected: sg.injected, fired: sg.fired, note: sg.note });
  if (sg.regressed) return r.set("fail", { evidence: sg.note,
    message: "validate self-guard regressed — refusing to run; orchestration not trustworthy" });
  if (!sg.ok) return r.set("unknown", { evidence: sg.note,
    message: "validate self-guard could not be exercised — verdict not trustworthy" });

  let callModel, plan, baseAnswer = null;
  if (opts.fixtures) {
    callModel = makeFixtureCallModel(resolvePath(opts.fixtures), m);
    plan = opts.plan || "(offline fixture scenario)";
  } else {
    callModel = makeProxyCallModel();
    plan = opts.plan;
    baseAnswer = opts.baseAnswer ?? null;
    if (!plan) return r.set("unknown", { evidence: "no --plan/--plan-file and no --fixtures",
      message: "validate: nothing to run" });
  }

  const v = await runValidate({ plan, manifest: m, callModel, baseAnswer, factcheck: opts.factcheck });
  r.chain(v);

  if (opts.report) { try { writeFileSync(opts.report, renderReport(v)); } catch { /* non-fatal */ } }

  if (v.verdict === "unknown") {
    // Base summary comes from the calling agent (Claude IS the base tier). A live
    // run with no --base-answer falls back to the base MODEL, which the proxy
    // does not serve — say so plainly rather than a generic "tier" message.
    const base = (v.tiers || []).find((t) => t.role === "base");
    if (!opts.fixtures && !baseAnswer && (!base || !base.responded)) return r.set("unknown", {
      evidence: `no base answer supplied and base model not reachable; ${v.downgrade_note || ""}`,
      message: "no base answer supplied and base model not reachable — the calling agent must supply its own answer via --base-answer" });
    return r.set("unknown", {
      evidence: `a tier could not be reached/parsed; ${v.downgrade_note || ""}`,
      message: "validate: chain incomplete — verdict unknown (never a fabricated cross-validation)" });
  }
  return r.set("pass", {
    evidence: `chain ran as specified; escalated=${v.escalated}, confidence=${v.confidence} ` +
              `(inter-model agreement, NOT correctness). ${sg.note}`,
    message: `validate: ${v.verdict} — ${v.riskCount} risk(s), confidence ${v.confidence}` });
}

function flag(argv, name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; }

// The base summary is the CALLING AGENT'S own neutral summary (Claude is the base
// tier, as in the original /validate skill). Accept it inline (--base-answer),
// from a file (--base-answer-file), or piped on stdin. undefined => none supplied.
function resolveBaseAnswer(argv) {
  const direct = flag(argv, "--base-answer");
  if (direct != null) return direct;
  const file = flag(argv, "--base-answer-file");
  if (file) { try { return readFileSync(file, "utf8"); } catch { return undefined; } }
  if (!process.stdin.isTTY) {
    try { const s = readFileSync(0, "utf8"); if (s && s.trim() !== "") return s; } catch { /* no stdin */ }
  }
  return undefined;
}

async function main(argv) {
  if (argv.includes("--self-test")) {
    return emitResult(selfGuardResult(await selfGuard()));
  }
  let plan = flag(argv, "--plan");
  const planFile = flag(argv, "--plan-file");
  if (!plan && planFile) { try { plan = readFileSync(planFile, "utf8"); } catch { /* leave undefined */ } }
  const opts = {
    fixtures: flag(argv, "--fixtures"),
    plan,
    baseAnswer: resolveBaseAnswer(argv),
    factcheck: argv.includes("--factcheck"),
    report: flag(argv, "--report"),
  };
  return emitResult(await run(opts));
}

main(process.argv.slice(2)).then((code) => process.exit(code));
export { selfGuard };
