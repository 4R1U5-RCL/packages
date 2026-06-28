#!/usr/bin/env node
// demo.mjs — the demonstration / smoke test (WORKING_METHOD §3).
//
// Proves BOTH controls earn their verdicts — the one thing this package exists to
// prove about itself: it does not false-pass.
//
//   cleanup: --self-test ok, good fixture => pass/exit0, bad fixture => fail/exit1
//            with the negative control shown to have been injected (a stray was
//            provably present). Then --apply on a TEMP COPY of the bad fixture
//            tidies it (re-scan: 0 stray) — proving the guarded mover works without
//            ever touching the bundled fixture.
//   backup:  --self-test ok AND its sentinel negative control FIRED (an archive
//            that misses a known file is caught); dry-run on the fixture tree =>
//            pass/exit0; --apply on a TEMP COPY writes and RE-VERIFIES a real
//            archive.
//
// Exits non-zero if any unit stops being able to fail its bad fixture — the
// regression backstop. (Deliberately removing the stray from fixtures/cleanup/bad,
// or breaking the sentinel control, makes this demo fail.)

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, rmSync, readdirSync } from "node:fs";
import { stageCopy } from "./checks/_fsutil.mjs";

const PKG = dirname(fileURLToPath(import.meta.url));
const node = process.execPath;

function control(name, args) {
  const r = spawnSync(node, [join(PKG, "checks", `${name}.mjs`), ...args],
                      { cwd: PKG, encoding: "utf8" });
  let obj = null;
  try { obj = JSON.parse((r.stdout || "").trim().split("\n").filter(Boolean).pop()); } catch { /* */ }
  return { exit: r.status, obj, stderr: r.stderr };
}

function selfTest(name) {
  const r = spawnSync(node, [join(PKG, "checks", `${name}.mjs`), "--self-test"],
                      { cwd: PKG, encoding: "utf8" });
  let obj = null;
  try { obj = JSON.parse((r.stdout || "").trim().split("\n").filter(Boolean).pop()); } catch { /* */ }
  return { exit: r.status, ok: obj?.self_guard_ok === true,
           injected: obj?.injected === true, fired: obj?.fired === true, obj };
}

function ok(b) { return b ? "ok " : "XX "; }

const rows = [];
let allPass = true;

// ── cleanup ───────────────────────────────────────────────────────────────────
{
  const st = selfTest("cleanup");
  const good = control("cleanup", ["--target", "fixtures/cleanup/good"]);
  const bad = control("cleanup", ["--target", "fixtures/cleanup/bad"]);
  const goodPass = good.obj?.status === "pass" && good.exit === 0;
  const badFail = bad.obj?.status === "fail" && bad.exit === 1;
  const ncInjected = bad.obj?.negative_control?.injected === true;

  // --apply on a throwaway copy of the bad fixture: must tidy to 0 stray.
  const stage = stageCopy(join(PKG, "fixtures", "cleanup", "bad"), "hygiene-demo-cln-");
  const applied = control("cleanup", ["--target", stage, "--apply"]);
  const applyPass = applied.obj?.status === "pass" && applied.exit === 0 &&
                    applied.obj?.details?.stray_after === 0 && applied.obj?.details?.moved?.length >= 1;
  try { rmSync(stage, { recursive: true, force: true }); } catch { /* */ }

  const earned = st.ok && goodPass && badFail && ncInjected && applyPass;
  if (!earned) allPass = false;
  rows.push({ control: "cleanup", selfTest: st.ok, fired: st.fired, goodPass, badFail, ncInjected, applyPass, earned });
}

// ── backup ──────────────────────────────────────────────────────────────────
{
  const st = selfTest("backup");
  const good = control("backup", ["--target", "fixtures/backup/tree"]); // dry-run
  const goodPass = good.obj?.status === "pass" && good.exit === 0;

  // --apply on a throwaway copy of the backup tree: writes & re-verifies a real archive.
  const stage = stageCopy(join(PKG, "fixtures", "backup", "tree"), "hygiene-demo-bkp-");
  const applied = control("backup", ["--target", stage, "--apply"]);
  const wrote = applied.obj?.details?.archive && existsSync(applied.obj.details.archive);
  const applyPass = applied.obj?.status === "pass" && applied.exit === 0 && wrote &&
                    (applied.obj?.details?.missing?.length ?? 1) === 0;
  try { rmSync(stage, { recursive: true, force: true }); } catch { /* */ }

  // backup's "bad fixture" is the sentinel-miss negative control: it must FIRE.
  const earned = st.ok && st.injected && st.fired && goodPass && applyPass;
  if (!earned) allPass = false;
  rows.push({ control: "backup", selfTest: st.ok, fired: st.fired, goodPass, badFail: st.fired,
              ncInjected: st.injected, applyPass, earned });
}

process.stderr.write("\n=== demonstration: every control watched to fail its bad input ===\n\n");
process.stderr.write("  control    self  bad-caught  good=PASS  nc-injected  apply=PASS  earned\n");
for (const r of rows) {
  process.stderr.write(`  ${r.control.padEnd(10)} ${ok(r.selfTest)}  ${ok(r.badFail)}` +
                       `       ${ok(r.goodPass)}      ${ok(r.ncInjected)}        ${ok(r.applyPass)}      ${ok(r.earned)}\n`);
}

// E-round: the wrapper layer (run.mjs) must not introduce a false pass. Dispatch
// the dry-run drift detector against a TEMP COPY of the tidy good fixture.
process.stderr.write("\n=== E-round: run.mjs dispatch over a tidy tree (no false pass) ===\n");
const stage = stageCopy(join(PKG, "fixtures", "cleanup", "good"), "hygiene-demo-er-");
const er = spawnSync(node, [join(PKG, "run.mjs"), "--only", "cleanup", "--target", stage],
                     { cwd: PKG, encoding: "utf8" });
process.stderr.write(er.stderr || "");
let erObj = null; try { erObj = JSON.parse(er.stdout); } catch { /* */ }
const erOk = erObj?.counts?.fail === 0 && erObj?.counts?.unknown === 0 && er.status === 0;
try { rmSync(stage, { recursive: true, force: true }); } catch { /* */ }
if (!erOk) allPass = false;

process.stderr.write(`\n${allPass ? "DEMONSTRATION PASSED" : "DEMONSTRATION FAILED"}: ` +
  `${rows.filter((r) => r.earned).length}/${rows.length} controls earned their verdicts; ` +
  `E-round dispatch ${erOk ? "clean" : "REGRESSED"}.\n\n`);

process.exit(allPass ? 0 : 1);
