#!/usr/bin/env node
// demo.mjs — the demonstration / smoke test (WORKING_METHOD §3).
//
// Proves BOTH controls earn their verdicts across ALL THREE profiles — the one
// thing this package exists to prove about itself: it does not false-pass.
//
//   For every profile (claude, codebase, llm-artifacts):
//     - cleanup --self-test fires its negative control (bad fixture caught), and
//       backup --self-test fires the sentinel-miss control;
//     - the RUN path returns fail/exit1 on the bad fixture and pass/exit0 on the
//       good one (the emit/dispatch layer introduces no false pass).
//   Plus the mutating claude paths (cleanup --apply mover, backup --apply writer)
//   on throwaway copies, a check that report-only profiles REFUSE --apply, and an
//   E-round run.mjs dispatch over a tidy tree.
//
// Exits non-zero if any unit stops being able to fail its bad fixture — the
// regression backstop. (Dropping the stray, the committed-junk, the misplaced
// artifact, or breaking the sentinel control makes this demo fail.)

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, rmSync } from "node:fs";
import { stageCopy, stageGitFixture, gitAdd } from "./checks/_fsutil.mjs";

const PKG = dirname(fileURLToPath(import.meta.url));
const node = process.execPath;
const FIX = (...p) => join(PKG, "fixtures", ...p);

function ctl(name, args) {
  const r = spawnSync(node, [join(PKG, "checks", `${name}.mjs`), ...args], { cwd: PKG, encoding: "utf8" });
  let obj = null;
  try { obj = JSON.parse((r.stdout || "").trim().split("\n").filter(Boolean).pop()); } catch { /* */ }
  return { exit: r.status, obj };
}
function selfTest(name, profile) {
  const { obj, exit } = ctl(name, ["--self-test", "--profile", profile]);
  return { exit, ok: obj?.self_guard_ok === true, injected: obj?.injected === true, fired: obj?.fired === true };
}
function ok(b) { return b ? "ok " : "XX "; }

// A codebase fixture must be a real git repo to be judged by the run path; stage a
// throwaway repo exactly as the self-guard does (bad: stage clean + committed-junk;
// good: add everything not gitignored). Returns the staged dir (caller cleans up).
function stageCodebase(which) {
  const d = stageGitFixture(FIX("codebase", which), `hygiene-demo-cb-${which}-`);
  if (which === "bad") gitAdd(d, [".gitignore", "src/app.ts", "build.tsbuildinfo"]);
  else gitAdd(d, "-A");
  return d;
}

const rows = [];
let allPass = true;

for (const profile of ["claude", "codebase", "llm-artifacts"]) {
  const cSelf = selfTest("cleanup", profile);
  const bSelf = selfTest("backup", profile);

  // RUN path good/bad. codebase needs a staged git repo; others read the fixture dir.
  let goodTarget, badTarget;
  if (profile === "claude") { goodTarget = FIX("cleanup", "good"); badTarget = FIX("cleanup", "bad"); }
  else if (profile === "codebase") { goodTarget = stageCodebase("good"); badTarget = stageCodebase("bad"); }
  else { goodTarget = FIX("llm-artifacts", "good"); badTarget = FIX("llm-artifacts", "bad"); }

  const good = ctl("cleanup", ["--profile", profile, "--target", goodTarget]);
  const bad = ctl("cleanup", ["--profile", profile, "--target", badTarget]);
  const goodPass = good.obj?.status === "pass" && good.exit === 0;
  const badFail = bad.obj?.status === "fail" && bad.exit === 1;

  // backup dry-run over the good target must verify (expected == archived).
  const bDry = ctl("backup", ["--profile", profile, "--target", goodTarget]);
  const backupPass = bDry.obj?.status === "pass" && bDry.exit === 0 &&
                     (bDry.obj?.details?.missing?.length ?? 1) === 0;

  if (profile === "codebase") { for (const d of [goodTarget, badTarget]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } } }

  const earned = cSelf.ok && cSelf.fired && bSelf.ok && bSelf.fired && goodPass && badFail && backupPass;
  if (!earned) allPass = false;
  rows.push({ profile, cSelf: cSelf.ok && cSelf.fired, bSelf: bSelf.ok && bSelf.fired, goodPass, badFail, backupPass, earned });
}

// Mutating claude paths on throwaway copies: the cleanup mover + the backup writer.
let claudeMutate = false;
{
  const clStage = stageCopy(FIX("cleanup", "bad"), "hygiene-demo-cln-");
  const applied = ctl("cleanup", ["--profile", "claude", "--target", clStage, "--apply"]);
  const movePass = applied.obj?.status === "pass" && applied.exit === 0 && applied.obj?.details?.stray_after === 0 && (applied.obj?.details?.moved?.length ?? 0) >= 1;
  try { rmSync(clStage, { recursive: true, force: true }); } catch { /* */ }

  const bkStage = stageCopy(FIX("backup", "tree"), "hygiene-demo-bkp-");
  const wrote = ctl("backup", ["--profile", "claude", "--target", bkStage, "--apply"]);
  const writePass = wrote.obj?.status === "pass" && wrote.exit === 0 && wrote.obj?.details?.archive && existsSync(wrote.obj.details.archive) && (wrote.obj?.details?.missing?.length ?? 1) === 0;
  try { rmSync(bkStage, { recursive: true, force: true }); } catch { /* */ }

  claudeMutate = movePass && writePass;
  if (!claudeMutate) allPass = false;
}

// Report-only profiles must REFUSE --apply (never mutate a codebase / artifact store).
let reportOnlyGuard = true;
for (const profile of ["codebase", "llm-artifacts"]) {
  const target = profile === "codebase" ? stageCodebase("good") : FIX("llm-artifacts", "good");
  const r = ctl("cleanup", ["--profile", profile, "--target", target, "--apply"]);
  if (!(r.obj?.status === "unknown" && /report-only/i.test(r.obj?.message || ""))) reportOnlyGuard = false;
  if (profile === "codebase") { try { rmSync(target, { recursive: true, force: true }); } catch { /* */ } }
}
if (!reportOnlyGuard) allPass = false;

process.stderr.write("\n=== demonstration: every control × profile watched to fail its bad input ===\n\n");
process.stderr.write("  profile         cleanup-self  backup-self  good=PASS  bad=FAIL  backup=PASS  earned\n");
for (const r of rows) {
  process.stderr.write(`  ${r.profile.padEnd(14)} ${ok(r.cSelf)}        ${ok(r.bSelf)}       ${ok(r.goodPass)}      ${ok(r.badFail)}     ${ok(r.backupPass)}      ${ok(r.earned)}\n`);
}
process.stderr.write(`\n  claude mutating paths (cleanup --apply mover + backup --apply writer): ${ok(claudeMutate)}\n`);
process.stderr.write(`  report-only profiles refuse --apply (no mutation of a codebase/artifact store): ${ok(reportOnlyGuard)}\n`);

// E-round: run.mjs over a tidy claude tree must not introduce a false pass.
const stage = stageCopy(FIX("cleanup", "good"), "hygiene-demo-er-");
const er = spawnSync(node, [join(PKG, "run.mjs"), "--only", "cleanup", "--target", stage], { cwd: PKG, encoding: "utf8" });
let erObj = null; try { erObj = JSON.parse(er.stdout); } catch { /* */ }
const erOk = erObj?.counts?.fail === 0 && erObj?.counts?.unknown === 0 && er.status === 0;
try { rmSync(stage, { recursive: true, force: true }); } catch { /* */ }
if (!erOk) allPass = false;

process.stderr.write(`\n${allPass ? "DEMONSTRATION PASSED" : "DEMONSTRATION FAILED"}: ` +
  `${rows.filter((r) => r.earned).length}/${rows.length} profiles earned their verdicts; ` +
  `E-round dispatch ${erOk ? "clean" : "REGRESSED"}.\n\n`);

process.exit(allPass ? 0 : 1);
