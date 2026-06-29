#!/usr/bin/env node
// cleanup.mjs — CONTROL: cleanup   SURFACE: local
//
// A drift detector across THREE profiles (profiles/<name>.json, --profile, default
// `claude`). Each profile declares cleanup.mode; this script dispatches on it:
//
//   claude  / mode "relocate"          the IOPHON ~/.claude §2 layout. Each file
//                                       kind has ONE canonical home, so a stray can
//                                       be MOVED (--apply). The only mutating mode.
//   codebase/ mode "git-junk"          a git working tree. REPORT-ONLY. Junk is
//                                       drift only if git would carry it (tracked,
//                                       or present and not gitignored). git is the
//                                       ignore authority; a non-repo => unknown.
//   llm-artifacts / mode "artifact-placement"  an artifact store. REPORT-ONLY.
//                                       Drift = a valuable artifact (transcript/
//                                       output) sitting inside a regenerable cache.
//
//   pass     no drift, and there was something to judge
//   fail     drift found (stray / committed-or-unignored junk / misplaced artifact)
//   unknown  could not scan, nothing classifiable, or a required precondition
//            (e.g. a git repo for the codebase profile) was absent
//
// REPORT-ONLY profiles NEVER move or delete — --apply is rejected for them. Only
// the claude profile relocates, and only with --apply (dry-run by default).
//
// SELF-GUARD FIRST (WORKING_METHOD §7/§8): each mode runs the SAME detector path
// against bundled good/bad fixtures before trusting a real verdict — the bad
// fixture MUST fire, the good MUST come back clean. _common.mjs structurally
// downgrades a pass whose negative control did not fire.
//
// Run:  node cleanup.mjs --target DIR [--profile claude|codebase|llm-artifacts]
//       node cleanup.mjs --target DIR --apply         # claude profile only (moves)
//       node cleanup.mjs --self-test [--profile ...]   # prove the detector works

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Result, emitResult } from "./_common.mjs";
import {
  scanTree, guardedMove, loadProfile, resolveExclude, walkTree, matchAnyGlob,
  pathHasComponent, isGitRepo, gitLsFiles, stageGitFixture, gitAdd,
} from "./_fsutil.mjs";
import { rmSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const FIX = (...p) => join(PKG, "fixtures", ...p);

const CONTROL = "cleanup";
const SURFACE = "local";

function baseOf(rel) { const i = rel.lastIndexOf("/"); return i < 0 ? rel : rel.slice(i + 1); }

// ── mode: relocate (claude) ───────────────────────────────────────────────────
// Unchanged behaviour from v0.2.1, now reading its rules from profiles/claude.json.
function relocate_selfGuard(cfg, exclude) {
  let bad, good;
  try {
    bad = scanTree(FIX("cleanup", "bad"), cfg.rules, exclude);
    good = scanTree(FIX("cleanup", "good"), cfg.rules, exclude);
  } catch (e) { return { ok: false, injected: false, fired: false, note: `fixtures unreadable: ${e.message}` }; }
  const injected = bad.stray.length >= 1;
  const fired = bad.stray.length >= 1;
  const clean = good.inPlace.length >= 1 && good.stray.length === 0;
  if (!injected) return { ok: false, injected, fired, note: `self-guard FAILED: bad fixture surfaced ${bad.stray.length} stray (expected a stray)` };
  if (!clean) return { ok: false, injected, fired, note: `self-guard FAILED: good fixture surfaced ${good.stray.length} stray / ${good.inPlace.length} in-place (false-positive)` };
  return { ok: true, injected, fired, note: `self-guard OK: bad flagged ${JSON.stringify(bad.stray.map((s) => s.from))}, good tidy (${good.inPlace.length} in place, 0 stray)` };
}

function relocate_run(r, target, cfg, exclude, apply) {
  const { stray, inPlace, scanned } = scanTree(target, cfg.rules, exclude);
  if (!apply) {
    r.detail({ scanned, in_place: inPlace.length, stray_count: stray.length,
               stray: stray.map((s) => ({ from: s.from, to: s.to, rule: s.rule })) });
    if (stray.length === 0 && inPlace.length === 0) {
      return r.set("unknown", { evidence: `scanned ${scanned} file(s) under ${target} but none matched any canonical rule — nothing to judge`, message: "cleanup: no classifiable files at target (unverifiable)" });
    }
    if (stray.length) {
      const CAP = 50;
      const listed = stray.slice(0, CAP).map((s) => `${s.from} -> ${s.to}`).join("; ");
      const more = stray.length > CAP ? ` (+${stray.length - CAP} more — see details.stray)` : "";
      return r.set("fail", { evidence: `${stray.length} stray file(s) violating the canonical layout: ${listed}${more}`, message: `cleanup: ${stray.length} stray file(s) (drift) — run --apply to tidy` });
    }
    return r.set("pass", { evidence: `tidy: ${inPlace.length} file(s) in canonical dir, 0 stray across ${scanned} scanned`, message: "cleanup: tree is tidy (zero stray)" });
  }
  // --apply: guarded moves.
  const moved = [], refused = [], failed = [];
  for (const s of stray) {
    const mv = guardedMove(target, s.from, s.to);
    if (mv.ok) moved.push({ from: s.from, to: s.to });
    else if (mv.refused) refused.push({ from: s.from, to: s.to, reason: mv.reason });
    else failed.push({ from: s.from, to: s.to, reason: mv.reason });
  }
  const after = scanTree(target, cfg.rules, exclude);
  r.detail({ moved, refused, failed, stray_before: stray.length, stray_after: after.stray.length });
  if (failed.length || refused.length) {
    const probs = [...refused, ...failed].map((x) => `${x.from}: ${x.reason}`).join("; ");
    return r.set("fail", { evidence: `applied ${moved.length} move(s); ${refused.length} refused, ${failed.length} failed (${after.stray.length} stray remain): ${probs}`, message: `cleanup --apply: ${moved.length} moved, ${refused.length + failed.length} could not be tidied` });
  }
  if (after.stray.length !== 0) {
    return r.set("unknown", { evidence: `moved ${moved.length} but ${after.stray.length} stray remain after re-scan`, message: "cleanup --apply: tree not confirmed tidy after moves" });
  }
  return r.set("pass", { evidence: `applied ${moved.length} guarded move(s); re-scan confirms 0 stray (each verified: source gone, dest present, no overwrite)`, message: `cleanup --apply: ${moved.length} file(s) moved into place, tree now tidy` });
}

// ── mode: git-junk (codebase) — REPORT ONLY ───────────────────────────────────
// Junk = a file matching junk_globs OR sitting inside a junk_dir. It is DRIFT only
// if git would carry it: TRACKED (committed) or present-and-not-gitignored. Junk
// that is correctly gitignored is expected, not drift.
function codebaseDrift(target, cfg, exclude) {
  if (!isGitRepo(target)) {
    return { unknown: true, reason: `not a git working tree: ${target} — the codebase profile delegates ignore resolution to git; point it at a repo` };
  }
  const tracked = new Set(gitLsFiles(target, []).files);
  const notIgnored = new Set(gitLsFiles(target, ["--others", "--exclude-standard"]).files);
  const junkGlobs = cfg.junk_globs || [];
  const junkDirs = cfg.junk_dirs || [];
  const drift = [];
  let scanned = 0, junkSeen = 0;
  for (const e of walkTree(target, { exclude, skipGit: true })) {
    scanned++;
    const isJunk = matchAnyGlob(baseOf(e.rel), junkGlobs) || pathHasComponent(e.rel, junkDirs);
    if (!isJunk) continue;
    junkSeen++;
    if (tracked.has(e.rel)) drift.push({ path: e.rel, why: "tracked junk (committed to the repo)" });
    else if (notIgnored.has(e.rel)) drift.push({ path: e.rel, why: "junk present and NOT gitignored (would be committed)" });
    // else: gitignored-and-present => expected local artifact, not drift.
  }
  return { unknown: false, drift, scanned, junkSeen, tracked: tracked.size };
}

function codebase_selfGuard(cfg, exclude) {
  // Stage throwaway copies, git-init, stage a deterministic set, run the SAME
  // detector. bad: stage the clean files + the committed-junk (build.tsbuildinfo),
  // leaving Thumbs.db untracked-not-ignored and dist//*.log gitignored — so BOTH
  // drift branches (tracked + unignored) fire. good: `git add -A` (all non-ignored)
  // => every junk file is gitignored => 0 drift.
  let badDir, goodDir;
  try {
    badDir = stageGitFixture(FIX("codebase", "bad"), "hygiene-cb-bad-");
    goodDir = stageGitFixture(FIX("codebase", "good"), "hygiene-cb-good-");
    gitAdd(badDir, [".gitignore", "src/app.ts", "build.tsbuildinfo"]);
    gitAdd(goodDir, "-A");
    const bad = codebaseDrift(badDir, cfg, exclude);
    const good = codebaseDrift(goodDir, cfg, exclude);
    if (bad.unknown || good.unknown) return { ok: false, injected: false, fired: false, note: `self-guard FAILED: git unavailable on a fixture (${bad.reason || good.reason})` };
    const injected = bad.drift.length >= 1;
    const fired = bad.drift.length >= 1;
    const clean = good.junkSeen >= 1 && good.drift.length === 0; // good HAS junk, all properly ignored
    if (!injected) return { ok: false, injected, fired, note: `self-guard FAILED: bad fixture surfaced ${bad.drift.length} drift (expected committed/unignored junk)` };
    if (!clean) return { ok: false, injected, fired, note: `self-guard FAILED: good fixture surfaced ${good.drift.length} drift across ${good.junkSeen} junk file(s) — false-positive (flagged correctly-ignored junk)` };
    return { ok: true, injected, fired, note: `self-guard OK: bad flagged ${JSON.stringify(bad.drift.map((d) => d.path))}, good clean (${good.junkSeen} junk files all gitignored, 0 drift)` };
  } catch (e) {
    return { ok: false, injected: false, fired: false, note: `self-guard error: ${e.message}` };
  } finally {
    for (const d of [badDir, goodDir]) { try { if (d) rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  }
}

function codebase_run(r, target, cfg, exclude) {
  const d = codebaseDrift(target, cfg, exclude);
  if (d.unknown) return r.set("unknown", { evidence: d.reason, message: "cleanup: codebase profile needs a git working tree (unverifiable)" });
  r.detail({ mode: "report-only", scanned: d.scanned, tracked: d.tracked, junk_seen: d.junkSeen,
             drift_count: d.drift.length, drift: d.drift });
  if (d.junkSeen === 0 && d.scanned === 0) return r.set("unknown", { evidence: `scanned 0 file(s) under ${target} — nothing to judge`, message: "cleanup: empty/unreadable target (unverifiable)" });
  if (d.drift.length) {
    const CAP = 50;
    const listed = d.drift.slice(0, CAP).map((x) => `${x.path} (${x.why})`).join("; ");
    const more = d.drift.length > CAP ? ` (+${d.drift.length - CAP} more — see details.drift)` : "";
    return r.set("fail", { evidence: `${d.drift.length} codebase-hygiene finding(s) [REPORT ONLY, nothing moved]: ${listed}${more}`, message: `cleanup: ${d.drift.length} committed/unignored junk finding(s) — report only` });
  }
  return r.set("pass", { evidence: `clean: ${d.junkSeen} junk-pattern file(s) seen, all correctly gitignored; 0 committed/unignored (scanned ${d.scanned})`, message: "cleanup: codebase clean (no committed/unignored junk)" });
}

// ── mode: artifact-placement (llm-artifacts) — REPORT ONLY ─────────────────────
function artifactDrift(target, cfg, exclude) {
  const valuableGlobs = cfg.valuable_globs || [];
  const cacheDirs = cfg.cache_dirs || [];
  const drift = [];
  let scanned = 0, valuable = 0;
  for (const e of walkTree(target, { exclude, skipGit: true })) {
    scanned++;
    if (!matchAnyGlob(baseOf(e.rel), valuableGlobs)) continue;
    valuable++;
    if (pathHasComponent(e.rel, cacheDirs)) drift.push({ path: e.rel, why: "valuable artifact inside a regenerable cache dir (would be lost to a cache purge)" });
  }
  return { drift, scanned, valuable };
}

function artifact_selfGuard(cfg, exclude) {
  let bad, good;
  try {
    bad = artifactDrift(FIX("llm-artifacts", "bad"), cfg, exclude);
    good = artifactDrift(FIX("llm-artifacts", "good"), cfg, exclude);
  } catch (e) { return { ok: false, injected: false, fired: false, note: `fixtures unreadable: ${e.message}` }; }
  const injected = bad.drift.length >= 1;
  const fired = bad.drift.length >= 1;
  const clean = good.valuable >= 1 && good.drift.length === 0;
  if (!injected) return { ok: false, injected, fired, note: `self-guard FAILED: bad fixture surfaced ${bad.drift.length} drift (expected a misplaced artifact)` };
  if (!clean) return { ok: false, injected, fired, note: `self-guard FAILED: good fixture surfaced ${good.drift.length} drift / ${good.valuable} valuable (false-positive)` };
  return { ok: true, injected, fired, note: `self-guard OK: bad flagged ${JSON.stringify(bad.drift.map((d) => d.path))}, good clean (${good.valuable} valuable, 0 misplaced)` };
}

function artifact_run(r, target, cfg, exclude) {
  const d = artifactDrift(target, cfg, exclude);
  r.detail({ mode: "report-only", scanned: d.scanned, valuable: d.valuable, drift_count: d.drift.length, drift: d.drift });
  if (d.valuable === 0) return r.set("unknown", { evidence: `scanned ${d.scanned} file(s) under ${target} but found 0 valuable artifacts (by extension) — nothing to judge`, message: "cleanup: no LLM artifacts at target (unverifiable)" });
  if (d.drift.length) {
    const CAP = 50;
    const listed = d.drift.slice(0, CAP).map((x) => x.path).join("; ");
    const more = d.drift.length > CAP ? ` (+${d.drift.length - CAP} more — see details.drift)` : "";
    return r.set("fail", { evidence: `${d.drift.length} valuable artifact(s) misplaced inside a cache dir [REPORT ONLY]: ${listed}${more}`, message: `cleanup: ${d.drift.length} artifact(s) at risk in a cache dir — report only` });
  }
  return r.set("pass", { evidence: `clean: ${d.valuable} valuable artifact(s), none inside a cache dir (scanned ${d.scanned})`, message: "cleanup: artifacts well-placed (none in a cache dir)" });
}

// ── dispatch ──────────────────────────────────────────────────────────────────
const DISPATCH = {
  relocate: { selfGuard: relocate_selfGuard, run: relocate_run, mutates: true },
  "git-junk": { selfGuard: codebase_selfGuard, run: codebase_run, mutates: false },
  "artifact-placement": { selfGuard: artifact_selfGuard, run: artifact_run, mutates: false },
};

function selfGuardFor(profile) {
  const cfg = profile.cleanup;
  const exclude = resolveExclude(PKG, cfg);
  return DISPATCH[cfg.mode].selfGuard(cfg, exclude);
}

function execute(profile, target, apply) {
  const cfg = profile.cleanup;
  const d = DISPATCH[cfg.mode];
  const r = new Result(CONTROL, SURFACE, `${cfg.title} [profile: ${profile.profile}]`);
  const sg = d.selfGuard(cfg, resolveExclude(PKG, cfg));
  r.negativeControl({ injected: sg.injected, fired: sg.fired, note: sg.note });
  if (!sg.ok) return r.set("unknown", { evidence: sg.note, message: `cleanup detector self-guard failed (${profile.profile}) — verdict not trustworthy` });

  if (apply && !d.mutates) {
    return r.set("unknown", { evidence: `the '${profile.profile}' profile is REPORT-ONLY — cleanup here never moves or deletes; --apply is not supported. Re-run without --apply for the drift report.`, message: `cleanup: --apply rejected (report-only profile '${profile.profile}')` });
  }
  if (cfg.mode === "relocate") return d.run(r, target, cfg, resolveExclude(PKG, cfg), apply);
  return d.run(r, target, cfg, resolveExclude(PKG, cfg));
}

function main(argv) {
  const ti = argv.indexOf("--target");
  const target = ti >= 0 ? argv[ti + 1] : process.cwd();
  const pi = argv.indexOf("--profile");
  const profileName = pi >= 0 ? argv[pi + 1] : "claude";
  const apply = argv.includes("--apply");
  let profile;
  try { profile = loadProfile(PKG, profileName); }
  catch (e) { console.log(JSON.stringify({ control: CONTROL, status: "unknown", evidence: `unknown profile '${profileName}': ${e.message}`, negative_control: { injected: false, fired: false, note: "" }, details: {} })); return 2; }
  if (!DISPATCH[profile.cleanup?.mode]) { console.log(JSON.stringify({ control: CONTROL, status: "unknown", evidence: `profile '${profileName}' has no known cleanup mode`, negative_control: { injected: false, fired: false, note: "" }, details: {} })); return 2; }

  if (argv.includes("--self-test")) {
    const sg = selfGuardFor(profile);
    console.log(JSON.stringify({ control: CONTROL, profile: profileName, self_guard_ok: sg.ok, injected: sg.injected, fired: sg.fired, note: sg.note }));
    return sg.ok ? 0 : 2;
  }
  return emitResult(execute(profile, target, apply));
}

process.exit(main(process.argv.slice(2)));
