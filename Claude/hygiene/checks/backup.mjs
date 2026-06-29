#!/usr/bin/env node
// backup.mjs — CONTROL: backup   SURFACE: local
//
// A PRESERVATION action that self-verifies, across THREE profiles (--profile,
// default `claude`). It only declares `pass` when the archive was created AND
// VERIFIED: sha256 stable across re-reads, extractable, and EVERY in-scope file
// present in the entry listing (proving the tree was captured, not an empty tar).
//
// Two engines, dispatched on profile.backup.engine:
//   exclude  (claude, llm-artifacts) — tar the whole target minus an exclude set
//            applied IDENTICALLY to the expected-file walk AND to tar (the v0.2.1
//            invariant: expected == archived).
//   git      (codebase) — the archived set is EXACTLY `git ls-files --cached
//            --others --exclude-standard` (tracked + untracked-not-ignored), minus
//            the backup exclude, fed to `tar -T`. git is the .gitignore authority,
//            so the set respects .gitignore exactly and expected == archived by
//            construction. A non-repo target => unknown.
//
//   pass / fail / unknown  as in cleanup; fail = an archive was produced but did
//   not verify; unknown = target unreadable/empty, tooling missing, or (git engine)
//   not a git repo.
//
// DRY-RUN BY DEFAULT: no --apply builds & verifies a throwaway archive in a temp
// dir and writes NOTHING to the target. --apply writes the real archive into the
// target's backup dir, RE-VERIFIES from disk, then prints the off-system-copy P2
// reminder.
//
// SELF-GUARD FIRST: the negative control is "an archive that misses a known file
// is caught." A sentinel is staged into a throwaway copy; the verifier must pass
// the positive archive and CATCH a negative archive that omits the sentinel. The
// git engine stages into a real git repo so the SAME git-authoritative path runs.
//
// Run:  node backup.mjs --target DIR [--profile claude|codebase|llm-artifacts]
//       node backup.mjs --target DIR --apply [--profile ...]   # WRITE the archive
//       node backup.mjs --self-test [--profile ...]            # prove the verifier

import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Result, emitResult } from "./_common.mjs";
import {
  walkTree, createArchive, createArchiveFromList, verifyArchive, listEntries, sha256File,
  stageCopy, stageGitFixture, injectSentinel, mkTmpDir, loadProfile, resolveExclude, isExcluded,
  isGitRepo, gitBackupSet, gitAdd,
} from "./_fsutil.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const FIX = (...p) => join(PKG, "fixtures", ...p);

const CONTROL = "backup";
const SURFACE = "local";

// Which fixture tree each profile's self-guard exercises.
const FIXTURE = {
  claude: FIX("backup", "tree"),
  "llm-artifacts": FIX("llm-artifacts", "good"),
  codebase: FIX("codebase", "good"),
};

// ── the expected-set + archive builders, per engine ──────────────────────────
// Both return { ok, expected, build(outPath, omit) , reason }. `build` writes an
// archive of the expected set to outPath; if `omit` is set, that one path is left
// out (the negative control). expected is the list verifyArchive checks against.

function excludeEngine(target, cfg) {
  const exclude = resolveExclude(PKG, cfg);
  const expected = walkTree(target, { exclude }).map((e) => e.rel);
  return {
    ok: expected.length > 0,
    expected,
    reason: expected.length ? "" : `0 in-scope files after excludes`,
    build: (outPath, omit) => createArchive(target, outPath, omit ? [...exclude, omit] : exclude),
  };
}

function gitEngine(target, cfg) {
  if (!isGitRepo(target)) return { ok: false, expected: [], reason: `not a git working tree`, gitMissing: true };
  const exclude = resolveExclude(PKG, cfg);
  const set = gitBackupSet(target);
  if (!set.ok) return { ok: false, expected: [], reason: `git ls-files failed: ${set.error}` };
  // Filter git's set by the backup exclude (drops *.tar.gz, the output dir, etc.)
  // so the archive never swallows prior backups. isExcluded mirrors tar's pruning.
  const expected = set.files.filter((rel) => !isExcluded(rel, exclude));
  return {
    ok: expected.length > 0,
    expected,
    nestedSkipped: set.nestedSkipped || 0,
    reason: expected.length ? "" : `git set empty after excludes`,
    // tar EXACTLY the (optionally-trimmed) list → archived == expected by construction.
    build: (outPath, omit) => createArchiveFromList(target, outPath, omit ? expected.filter((f) => f !== omit) : expected),
  };
}

function engineFor(target, cfg) {
  return cfg.engine === "git" ? gitEngine(target, cfg) : excludeEngine(target, cfg);
}

// ── self-guard (engine-agnostic, uses a staged copy + sentinel) ───────────────
function selfGuard(profile) {
  const cfg = profile.backup;
  const fixture = FIXTURE[profile.profile];
  let stage, posDir, negDir;
  try {
    // git engine: stage into a real repo (renames the fixture's gitignore -> .gitignore)
    // so the SAME git-authoritative file-set path runs; then track the sentinel too.
    stage = cfg.engine === "git" ? stageGitFixture(fixture, "hygiene-bkp-stage-") : stageCopy(fixture, "hygiene-bkp-stage-");
    injectSentinel(stage, cfg.sentinel_name);
    if (cfg.engine === "git") gitAdd(stage, "-A"); // sentinel is now tracked

    const eng = engineFor(stage, cfg);
    if (!eng.ok) return { ok: false, injected: false, fired: false, note: `self-guard FAILED: staged fixture yielded no expected set (${eng.reason})` };
    if (!eng.expected.includes(cfg.sentinel_name)) return { ok: false, injected: false, fired: false, note: `self-guard FAILED: sentinel '${cfg.sentinel_name}' not in expected set (${eng.expected.length} files)` };

    posDir = mkTmpDir("hygiene-bkp-pos-"); negDir = mkTmpDir("hygiene-bkp-neg-");
    const posPath = join(posDir, "good.tar.gz");
    const negPath = join(negDir, "missing.tar.gz");

    const cPos = eng.build(posPath, null);
    if (!cPos.ok) return { ok: false, injected: false, fired: false, note: `self-guard FAILED: could not build positive archive: ${cPos.error}` };
    const vPos = verifyArchive(posPath, eng.expected);

    const cNeg = eng.build(negPath, cfg.sentinel_name);
    if (!cNeg.ok) return { ok: false, injected: false, fired: false, note: `self-guard FAILED: could not build negative archive: ${cNeg.error}` };
    const negList = listEntries(negPath);
    const injected = negList.ok && !negList.entries.includes(cfg.sentinel_name);
    const vNeg = verifyArchive(negPath, eng.expected);
    const fired = vNeg.ok === false && (vNeg.missing || []).includes(cfg.sentinel_name);

    const ok = vPos.ok && injected && fired;
    return {
      ok, injected, fired,
      note: ok
        ? `self-guard OK: positive archive verified (${vPos.entries} entries, sha ${vPos.sha256.slice(0, 12)}…, extractable, stable); negative archive omitting '${cfg.sentinel_name}' was CAUGHT (${vNeg.reason})`
        : `self-guard FAILED: positive=${vPos.reason}; negative injected=${injected} fired=${fired} (${vNeg.reason})`,
    };
  } catch (e) {
    return { ok: false, injected: false, fired: false, note: `self-guard error: ${e.message}` };
  } finally {
    for (const d of [stage, posDir, negDir]) { try { if (d) rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  }
}

function tsName(prefix) {
  return prefix + new Date().toISOString().replace(/[:.]/g, "-") + ".tar.gz";
}

function dryRun(profile, target) {
  const cfg = profile.backup;
  const r = new Result(CONTROL, SURFACE, `${cfg.title} [profile: ${profile.profile}]`);
  const sg = selfGuard(profile);
  r.negativeControl({ injected: sg.injected, fired: sg.fired, note: sg.note });
  if (!sg.ok) return r.set("unknown", { evidence: sg.note, message: `backup verifier self-guard failed (${profile.profile}) — verdict not trustworthy` });

  const eng = engineFor(target, cfg);
  if (eng.gitMissing) return r.set("unknown", { evidence: `${eng.reason}: ${target} — the codebase profile delegates ignore resolution to git; point it at a repo`, message: "backup: codebase profile needs a git working tree (unverifiable)" });
  if (!eng.ok) return r.set("unknown", { evidence: `target ${target}: ${eng.reason} — nothing to back up or unreadable`, message: "backup: nothing to archive at target (unverifiable)" });

  const outDir = mkTmpDir("hygiene-bkp-dry-");
  const outPath = join(outDir, "dryrun.tar.gz");
  try {
    const c = eng.build(outPath, null);
    if (!c.ok) return r.set("unknown", { evidence: `tar could not build a trial archive: ${c.error}`, message: "backup: archive tooling failed (unverifiable)" });
    const v = verifyArchive(outPath, eng.expected);
    r.detail({ mode: "dry-run", engine: cfg.engine, would_write_to: cfg.output_dir, expected_files: eng.expected.length, archive_entries: v.entries, nested_skipped: eng.nestedSkipped || 0, sha256: v.sha256, stable: v.stable, extractable: v.extractable, missing: v.missing });
    if (!v.ok) return r.set("fail", { evidence: `trial archive of ${target} did NOT verify: ${v.reason}`, message: "backup: archive failed verification (would not be a safe backup)" });
    return r.set("pass", { evidence: `trial archive verified: ${v.entries} entries capture all ${eng.expected.length} in-scope file(s), sha256 stable (${v.sha256.slice(0, 12)}…), extractable. DRY-RUN — nothing written. --apply to write into ${cfg.output_dir}.`, message: "backup: archive builds and verifies (dry-run; --apply to write)" });
  } finally {
    try { rmSync(outDir, { recursive: true, force: true }); } catch { /* */ }
  }
}

function apply(profile, target) {
  const cfg = profile.backup;
  const r = new Result(CONTROL, SURFACE, `${cfg.title} [profile: ${profile.profile}]`);
  const sg = selfGuard(profile);
  r.negativeControl({ injected: sg.injected, fired: sg.fired, note: sg.note });
  if (!sg.ok) return r.set("unknown", { evidence: sg.note, message: `backup verifier self-guard failed (${profile.profile}) — refusing to declare a verified backup` });

  const eng = engineFor(target, cfg);
  if (eng.gitMissing) return r.set("unknown", { evidence: `${eng.reason}: ${target}`, message: "backup: codebase profile needs a git working tree (unverifiable)" });
  if (!eng.ok) return r.set("unknown", { evidence: `target ${target}: ${eng.reason}`, message: "backup: nothing to archive at target (unverifiable)" });

  const outDir = join(target, cfg.output_dir);
  mkdirSync(outDir, { recursive: true });
  const archivePath = join(outDir, tsName(cfg.archive_prefix));

  const c = eng.build(archivePath, null);
  if (!c.ok) return r.set("unknown", { evidence: `tar could not write the archive: ${c.error}`, message: "backup --apply: archive tooling failed (no backup written)" });

  const v = verifyArchive(archivePath, eng.expected);
  const sha = sha256File(archivePath);
  writeFileSync(archivePath + ".sha256", `${sha}  ${archivePath.split("/").pop()}\n`);
  const listed = listEntries(archivePath);
  writeFileSync(archivePath + ".manifest.txt", (listed.entries || []).join("\n") + "\n");
  r.detail({ mode: "apply", engine: cfg.engine, archive: archivePath, sha256: sha, expected_files: eng.expected.length, archive_entries: v.entries, nested_skipped: eng.nestedSkipped || 0, stable: v.stable, extractable: v.extractable, missing: v.missing });

  if (!v.ok) return r.set("fail", { evidence: `wrote ${archivePath} but RE-VERIFY failed: ${v.reason} — do not trust this archive`, message: "backup --apply: written archive did not verify (NOT a safe backup)" });

  process.stderr.write(`\n  [backup] wrote & verified ${archivePath}\n  [backup] sha256: ${sha}\n  [backup] P2 (human): copy this archive OFF-SYSTEM (it is not a backup until it lives somewhere this host can fail without taking it down).\n\n`);
  return r.set("pass", { evidence: `wrote ${archivePath} (+ .sha256, .manifest.txt) and RE-VERIFIED from disk: ${v.entries} entries capture all ${eng.expected.length} in-scope file(s), sha256 stable, extractable. Off-system copy reminder printed.`, message: "backup --apply: archive written and verified (remember the off-system copy)" });
}

function main(argv) {
  const ti = argv.indexOf("--target");
  const target = ti >= 0 ? argv[ti + 1] : process.cwd();
  const pi = argv.indexOf("--profile");
  const profileName = pi >= 0 ? argv[pi + 1] : "claude";
  let profile;
  try { profile = loadProfile(PKG, profileName); }
  catch (e) { console.log(JSON.stringify({ control: CONTROL, status: "unknown", evidence: `unknown profile '${profileName}': ${e.message}`, negative_control: { injected: false, fired: false, note: "" }, details: {} })); return 2; }

  if (argv.includes("--self-test")) {
    const sg = selfGuard(profile);
    console.log(JSON.stringify({ control: CONTROL, profile: profileName, self_guard_ok: sg.ok, injected: sg.injected, fired: sg.fired, note: sg.note }));
    return sg.ok ? 0 : 2;
  }
  if (argv.includes("--apply")) return emitResult(apply(profile, target));
  return emitResult(dryRun(profile, target));
}

process.exit(main(process.argv.slice(2)));
