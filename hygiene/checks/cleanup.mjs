#!/usr/bin/env node
// cleanup.mjs — CONTROL: cleanup   SURFACE: local
//
// A DRIFT DETECTOR for the IOPHON ~/.claude tree. It scans the target against the
// FIXED canonical-layout rules (manifests/cleanup.json) and reports stray files —
// files of a known kind sitting outside their one canonical subdirectory.
//
//   pass     zero stray files AND at least one file correctly in place (tidy)
//   fail     one or more stray files (drift)
//   unknown  could not scan, or nothing matched a rule (nothing to judge)
//
// It ALSO has a mutating `--apply` mode that MOVES each stray file to its
// canonical dir. --apply is human-gated and DRY-RUN BY DEFAULT, matching the
// original /cleanup skill: a run with no --apply only reports what WOULD move.
// Each move is guarded — it refuses to overwrite an existing dest and verifies
// the file landed (source gone, dest present).
//
// SELF-GUARD FIRST (WORKING_METHOD §7/§8). Before trusting any verdict on a real
// target, the same scanTree() path is run against bundled fixtures:
//   - fixtures/cleanup/bad  MUST surface >=1 stray (negative control FIRES),
//   - fixtures/cleanup/good MUST surface 0 stray with >=1 file in place (guards
//     against a detector that flags everything / false-positives).
// If the self-guard does not hold the detector is broken: emit `unknown`, never
// a pass. _common.mjs structurally downgrades a pass without a fired negative
// control.
//
// Run:  node cleanup.mjs --target /path/to/tree            # dry-run drift report
//       node cleanup.mjs --target /path/to/tree --apply    # MOVE stray files
//       node cleanup.mjs --self-test                        # prove the detector works

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Result, emitResult } from "./_common.mjs";
import { scanTree, guardedMove } from "./_fsutil.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const MANIFEST = join(PKG, "manifests", "cleanup.json");
const FIX_GOOD = join(PKG, "fixtures", "cleanup", "good");
const FIX_BAD = join(PKG, "fixtures", "cleanup", "bad");

const CONTROL = "cleanup";
const SURFACE = "local";
const TITLE = "config drift detector (IOPHON ~/.claude §2 layout)";

function loadManifest() {
  return JSON.parse(readFileSync(MANIFEST, "utf8"));
}

// Returns { ok, injected, fired, note }. ok=false => detector is broken.
function selfGuard() {
  const m = loadManifest();
  let bad, good;
  try {
    bad = scanTree(FIX_BAD, m.rules, m.exclude);
    good = scanTree(FIX_GOOD, m.rules, m.exclude);
  } catch (e) {
    return { ok: false, injected: false, fired: false, note: `fixtures unreadable: ${e.message}` };
  }
  // injected: the bad fixture really contains a stray (bad input provably present).
  const injected = bad.stray.length >= 1;
  const fired = bad.stray.length >= 1;                // our detector flagged it
  const clean = good.inPlace.length >= 1 && good.stray.length === 0; // good parsed & tidy
  if (!injected) {
    return { ok: false, injected, fired,
             note: `self-guard FAILED: bad fixture surfaced ${bad.stray.length} stray ` +
                   `file(s) — negative control could not be injected (expected a stray file)` };
  }
  if (!clean) {
    return { ok: false, injected, fired,
             note: `self-guard FAILED: good fixture surfaced ${good.stray.length} stray / ` +
                   `${good.inPlace.length} in-place — detector false-positives or did not classify, ` +
                   `cannot trust it` };
  }
  return { ok: true, injected, fired,
           note: `self-guard OK: bad fixture flagged ${JSON.stringify(bad.stray.map((s) => s.from))}, ` +
                 `good fixture tidy (${good.inPlace.length} in place, 0 stray)` };
}

function run(target) {
  const r = new Result(CONTROL, SURFACE, TITLE);
  const sg = selfGuard();
  r.negativeControl({ injected: sg.injected, fired: sg.fired, note: sg.note });
  if (!sg.ok) {
    return r.set("unknown", { evidence: sg.note,
      message: "cleanup detector self-guard failed — verdict not trustworthy" });
  }

  const m = loadManifest();
  const { stray, inPlace, scanned } = scanTree(target, m.rules, m.exclude);
  r.detail({ scanned, in_place: inPlace.length, stray_count: stray.length,
             stray: stray.map((s) => ({ from: s.from, to: s.to, rule: s.rule })) });

  if (stray.length === 0 && inPlace.length === 0) {
    return r.set("unknown", {
      evidence: `scanned ${scanned} file(s) under ${target} but none matched any canonical ` +
                `rule — nothing to judge; check the target path`,
      message: "cleanup: no classifiable files at target (unverifiable)" });
  }
  if (stray.length) {
    const listed = stray.map((s) => `${s.from} -> ${s.to}`).join("; ");
    return r.set("fail", {
      evidence: `${stray.length} stray file(s) violating the canonical layout: ${listed}`,
      message: `cleanup: ${stray.length} stray file(s) (drift) — run --apply to tidy` });
  }
  return r.set("pass", {
    evidence: `tidy: ${inPlace.length} file(s) in their canonical dir, 0 stray across ` +
              `${scanned} scanned; ${sg.note}`,
    message: "cleanup: tree is tidy (zero stray)" });
}

// MUTATING. Detects stray files then MOVES each to its canonical dir, guarded.
function apply(target) {
  const r = new Result(CONTROL, SURFACE, TITLE);
  const sg = selfGuard();
  r.negativeControl({ injected: sg.injected, fired: sg.fired, note: sg.note });
  if (!sg.ok) {
    return r.set("unknown", { evidence: sg.note,
      message: "cleanup detector self-guard failed — refusing to move files" });
  }

  const m = loadManifest();
  const before = scanTree(target, m.rules, m.exclude);
  const moved = [], refused = [], failed = [];
  for (const s of before.stray) {
    const mv = guardedMove(target, s.from, s.to);
    if (mv.ok) moved.push({ from: s.from, to: s.to });
    else if (mv.refused) refused.push({ from: s.from, to: s.to, reason: mv.reason });
    else failed.push({ from: s.from, to: s.to, reason: mv.reason });
  }
  const after = scanTree(target, m.rules, m.exclude);
  r.detail({ moved, refused, failed, stray_before: before.stray.length, stray_after: after.stray.length });

  if (failed.length || refused.length) {
    const probs = [...refused, ...failed].map((x) => `${x.from}: ${x.reason}`).join("; ");
    return r.set("fail", {
      evidence: `applied ${moved.length} move(s); ${refused.length} refused, ${failed.length} failed ` +
                `(${after.stray.length} stray remain): ${probs}`,
      message: `cleanup --apply: ${moved.length} moved, ${refused.length + failed.length} could not be tidied` });
  }
  if (after.stray.length !== 0) {
    return r.set("unknown", {
      evidence: `moved ${moved.length} file(s) but ${after.stray.length} stray still detected after — ` +
                `re-scan did not confirm a tidy tree`,
      message: "cleanup --apply: tree not confirmed tidy after moves" });
  }
  return r.set("pass", {
    evidence: `applied ${moved.length} guarded move(s) to canonical dirs; re-scan confirms 0 stray ` +
              `(each move verified: source gone, dest present, no overwrite); ${sg.note}`,
    message: `cleanup --apply: ${moved.length} file(s) moved into place, tree now tidy` });
}

function main(argv) {
  const i = argv.indexOf("--target");
  const target = i >= 0 ? argv[i + 1] : process.cwd();
  if (argv.includes("--self-test")) {
    const sg = selfGuard();
    console.log(JSON.stringify({ control: CONTROL, self_guard_ok: sg.ok,
      injected: sg.injected, fired: sg.fired, note: sg.note }));
    return sg.ok ? 0 : 2;
  }
  if (argv.includes("--apply")) return emitResult(apply(target));
  return emitResult(run(target));
}

process.exit(main(process.argv.slice(2)));
