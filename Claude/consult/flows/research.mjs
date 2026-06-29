#!/usr/bin/env node
// research.mjs — FLOW: research   (thin caller over lib/_chain.mjs)
//
// Answer a question through the chain: base -> validator -> revalidator
// (+ optional consented Perplexity fact-check), then label CONFIDENCE from
// inter-model agreement (HIGH/MEDIUM/LOW). All orchestration lives in
// lib/_chain.mjs — this file only wires inputs, self-guards, and emits.
//
// SHAPE — mirrors audit/checks/rls.mjs (the reference check):
//   1. Read the FIXED manifest (manifests/research.json) — tiers + scoring policy
//      are not run-time discretion.
//   2. SELF-GUARD FIRST against RECORDED fixtures, running the SAME runResearch()
//      path used live:
//        - research/agree    MUST score HIGH (false-positive guard),
//        - research/disagree  MUST score LOW with BOTH positions surfaced
//          (the divergence negative control FIRES),
//        - malformed/corroborators-empty MUST NOT count the dead tiers (no HIGH),
//        - malformed/base-unreachable MUST yield verdict=unknown (never fabricated).
//      If any invariant is broken => the orchestration is not trustworthy:
//        a violated firing invariant => fail; a fixture that cannot be exercised
//        => unknown. NEVER a silent pass.
//   3. Only with a fired negative control do we trust a live/scenario run.
//      _common.mjs structurally downgrades a pass whose negative control did not fire.
//
// Run:  node flows/research.mjs --self-test
//       node flows/research.mjs --fixtures fixtures/research/agree     (offline scenario)
//       node flows/research.mjs --question "..." [--factcheck] [--report out.md]   (live proxy)

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";
import { Result, emitResult, EXIT } from "../lib/_common.mjs";
import { runResearch, makeFixtureCallModel } from "../lib/_chain.mjs";
import { makeProxyCallModel } from "../lib/_proxy.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const MANIFEST = join(PKG, "manifests", "research.json");
const FIX = join(PKG, "fixtures");
const FLOW = "research";

function loadManifest() { return JSON.parse(readFileSync(MANIFEST, "utf8")); }

async function selfGuard() {
  const m = loadManifest();
  let agree, disagree, corrEmpty, baseUnreach;
  try {
    agree = await runResearch({ question: "self-guard", manifest: m,
      callModel: makeFixtureCallModel(join(FIX, "research", "agree"), m) });
    disagree = await runResearch({ question: "self-guard", manifest: m,
      callModel: makeFixtureCallModel(join(FIX, "research", "disagree"), m) });
    corrEmpty = await runResearch({ question: "self-guard", manifest: m,
      callModel: makeFixtureCallModel(join(FIX, "malformed", "corroborators-empty"), m) });
    baseUnreach = await runResearch({ question: "self-guard", manifest: m,
      callModel: makeFixtureCallModel(join(FIX, "malformed", "base-unreachable"), m) });
  } catch (e) {
    return { ok: false, regressed: false, injected: false, fired: false,
             note: `fixtures unreadable: ${e.message}` };
  }

  // injected: the disagree fixture provably carries a dissenting corroborator
  // (the divergence is really present, not an empty/unmatched scan).
  const injected = disagree.tiers.some(
    (t) => t.role !== "base" && !t.optionalSkipped && t.responded && t.stance === "dissent");
  // fired: the divergence control reacted — LOW, not corroborated, both surfaced.
  const fired = disagree.confidence === "LOW" && disagree.corroborated === false &&
    (disagree.positions || []).length >= 2;
  const cleanHigh = agree.confidence === "HIGH" && agree.corroborated === true &&
    agree.verdict === "validated";
  const corrGuard = corrEmpty.confidence !== "HIGH" && corrEmpty.corroborated === false;
  const unreachGuard = baseUnreach.verdict === "unknown" && baseUnreach.confidence === null;

  if (!injected) return { ok: false, regressed: false, injected, fired,
    note: `self-guard FAILED: disagree fixture carried no dissenting corroborator — ` +
          `negative control could not be injected` };
  if (!fired) return { ok: false, regressed: true, injected, fired,
    note: `self-guard REGRESSED: divergence did not score LOW ` +
          `(got ${disagree.confidence}, corroborated=${disagree.corroborated}, positions=${(disagree.positions||[]).length})` };
  if (!cleanHigh) return { ok: false, regressed: true, injected, fired,
    note: `self-guard REGRESSED: agreement fixture did not reach HIGH ` +
          `(got ${agree.confidence}/${agree.verdict}) — false-positive` };
  if (!corrGuard) return { ok: false, regressed: true, injected, fired,
    note: `self-guard REGRESSED: malformed/empty corroborators were counted as agreement ` +
          `(got ${corrEmpty.confidence}/corroborated=${corrEmpty.corroborated})` };
  if (!unreachGuard) return { ok: false, regressed: true, injected, fired,
    note: `self-guard REGRESSED: unreachable base did not yield unknown ` +
          `(got ${baseUnreach.verdict}/${baseUnreach.confidence})` };
  return { ok: true, regressed: false, injected, fired,
    note: `self-guard OK: agreement=>HIGH, divergence=>LOW (both positions surfaced), ` +
          `malformed corroborators not counted, unreachable base=>unknown` };
}

function selfGuardResult(sg) {
  const r = new Result(FLOW);
  r.negativeControl({ injected: sg.injected, fired: sg.fired, note: sg.note });
  if (sg.regressed) return r.set("fail", { evidence: sg.note,
    message: "research orchestration invariant violated (scoring regressed)" });
  if (!sg.ok) return r.set("unknown", { evidence: sg.note,
    message: "research self-guard could not be exercised — verdict not trustworthy" });
  return r.set("pass", { evidence: sg.note,
    message: "research orchestration self-guard fired (scoring invariants hold)" });
}

function renderReport(v) {
  const lines = [];
  lines.push(`# research report`);
  lines.push(``);
  lines.push(`> CONFIDENCE is INTER-MODEL AGREEMENT, not a claim of correctness. ` +
             `A HIGH means the models concurred — verify load-bearing facts independently.`);
  lines.push(``);
  lines.push(`- **verdict:** ${v.verdict}`);
  lines.push(`- **confidence:** ${v.confidence ?? "n/a"}  (corroborated: ${v.corroborated})`);
  lines.push(``);
  lines.push(`## tiers`);
  for (const t of v.tiers) {
    lines.push(`- \`${t.role}\` (${t.model}): responded=${t.responded}` +
               `${t.optionalSkipped ? " [skipped]" : ""}${t.stance ? `, stance=${t.stance}` : ""}` +
               `${t.error ? `, ${t.error}` : ""}`);
  }
  lines.push(``);
  lines.push(`## positions`);
  for (const p of (v.positions || [])) {
    lines.push(`- **${p.tier}** (${p.model}${p.stance ? `, ${p.stance}` : ""}): ${p.position}`);
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
    message: "research self-guard regressed — refusing to run; orchestration not trustworthy" });
  if (!sg.ok) return r.set("unknown", { evidence: sg.note,
    message: "research self-guard could not be exercised — verdict not trustworthy" });

  let callModel, question, baseAnswer = null;
  if (opts.fixtures) {
    callModel = makeFixtureCallModel(resolvePath(opts.fixtures), m);
    question = opts.question || "(offline fixture scenario)";
  } else {
    callModel = makeProxyCallModel();
    question = opts.question;
    baseAnswer = opts.baseAnswer ?? null;
    if (!question) return r.set("unknown", { evidence: "no --question and no --fixtures",
      message: "research: nothing to run" });
  }

  const v = await runResearch({ question, manifest: m, callModel, baseAnswer, factcheck: opts.factcheck });
  r.chain(v);

  if (opts.report) { try { writeFileSync(opts.report, renderReport(v)); } catch { /* non-fatal */ } }

  if (v.verdict === "unknown") {
    // The base answer comes from the calling agent (Claude IS the base tier).
    // A live run with no --base-answer falls back to the base MODEL, which the
    // proxy does not serve — say so plainly rather than a generic "tier" message.
    const base = (v.tiers || []).find((t) => t.role === "base");
    if (!opts.fixtures && !baseAnswer && (!base || !base.responded)) return r.set("unknown", {
      evidence: `no base answer supplied and base model not reachable; ${v.downgrade_note || ""}`,
      message: "no base answer supplied and base model not reachable — the calling agent must supply its own answer via --base-answer" });
    return r.set("unknown", {
      evidence: `a tier could not be reached/parsed; ${v.downgrade_note || ""}`,
      message: "research: chain incomplete — verdict unknown (never a fabricated cross-validated answer)" });
  }
  return r.set("pass", {
    evidence: `chain ran as specified; confidence=${v.confidence} (inter-model agreement, NOT correctness). ${sg.note}`,
    message: `research: ${v.verdict} — confidence ${v.confidence}` });
}

function flag(argv, name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; }

// The base answer is the CALLING AGENT'S own answer (Claude is the base tier, as
// in the original /research skill). Accept it inline (--base-answer), from a file
// (--base-answer-file), or piped on stdin. undefined => none supplied.
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
  const opts = {
    fixtures: flag(argv, "--fixtures"),
    question: flag(argv, "--question"),
    baseAnswer: resolveBaseAnswer(argv),
    factcheck: argv.includes("--factcheck"),
    report: flag(argv, "--report"),
  };
  return emitResult(await run(opts));
}

main(process.argv.slice(2)).then((code) => process.exit(code));
export { selfGuard };
