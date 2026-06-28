#!/usr/bin/env node
// backup.mjs — CONTROL: backup   SURFACE: local
//
// A PRESERVATION action that self-verifies. It creates a .tar.gz of the target
// config tree (+ a .sha256 and a manifest of entries) and only declares `pass`
// when the archive was created AND VERIFIED: its sha256 is stable across re-reads,
// it is extractable, and every in-scope file is present in the entry listing
// (proving the archive captured the tree, not an empty/partial tar).
//
//   pass     archive created AND verified (stable sha256, extractable, tree captured)
//   fail     an archive was produced but did NOT verify (missed files / not stable
//            / not extractable) — a real finding
//   unknown  could not run — target unreadable/empty, tar/sha tooling failed
//
// DRY-RUN BY DEFAULT (matching the original /backup skill): a run with no --apply
// builds & verifies a throwaway archive in a temp dir and reports the capability,
// writing NOTHING into the target. `--apply` writes the real archive into the
// target's backups dir, RE-VERIFIES it from disk, and then prints the off-system
// copy reminder — the human-gated P2 step.
//
// SELF-GUARD FIRST (WORKING_METHOD §7/§8) — and the negative control is the soul
// of this control: "an archive that misses a known file is caught." The self-test
// stages a temp copy of fixtures/backup/tree, injects a SENTINEL file, then:
//   - POSITIVE: archives the staging tree and confirms the verifier passes it
//     (sentinel present, sha256 stable, extractable),
//   - NEGATIVE: builds an archive that DELIBERATELY OMITS the sentinel and
//     confirms the verifier CATCHES the miss (fires).
// The sentinel is only ever written into the temp staging copy — NEVER the real
// target. If the negative control does not fire the verifier is broken: `unknown`,
// never a pass (_common.mjs enforces this structurally).
//
// Run:  node backup.mjs --target /path/to/tree            # dry-run: build+verify in temp
//       node backup.mjs --target /path/to/tree --apply    # WRITE the real archive
//       node backup.mjs --self-test                        # prove the verifier works

import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Result, emitResult } from "./_common.mjs";
import {
  walkTree, createArchive, verifyArchive, listEntries, sha256File,
  stageCopy, injectSentinel, mkTmpDir, SENTINEL_NAME,
} from "./_fsutil.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const MANIFEST = join(PKG, "manifests", "backup.json");
const FIX_TREE = join(PKG, "fixtures", "backup", "tree");

const CONTROL = "backup";
const SURFACE = "local";
const TITLE = "self-verifying config-tree backup";

function loadManifest() {
  return JSON.parse(readFileSync(MANIFEST, "utf8"));
}

// Returns { ok, injected, fired, note }. ok=false => verifier is broken.
function selfGuard() {
  const m = loadManifest();
  const exclude = m.exclude.filter((e) => e !== "data/backups"); // fixture has none anyway
  let stage, posDir, negDir;
  try {
    stage = stageCopy(FIX_TREE, "hygiene-bkp-stage-");
    injectSentinel(stage, m.sentinel_name);
    const expected = walkTree(stage, { exclude }).map((e) => e.rel);
    if (!expected.includes(m.sentinel_name)) {
      return { ok: false, injected: false, fired: false,
               note: "self-guard FAILED: sentinel not in staged expected set" };
    }
    posDir = mkTmpDir("hygiene-bkp-pos-");
    negDir = mkTmpDir("hygiene-bkp-neg-");
    const posPath = join(posDir, "good.tar.gz");
    const negPath = join(negDir, "missing.tar.gz");

    // POSITIVE: archive everything (sentinel included) — verifier should pass.
    const cPos = createArchive(stage, posPath, exclude);
    if (!cPos.ok) {
      return { ok: false, injected: false, fired: false,
               note: `self-guard FAILED: could not build positive archive (tar): ${cPos.error}` };
    }
    const vPos = verifyArchive(posPath, expected);

    // NEGATIVE: archive WITHOUT the sentinel — the verifier (still expecting it)
    // must catch the miss. This is the "archive that misses a known file" control.
    const cNeg = createArchive(stage, negPath, [...exclude, m.sentinel_name]);
    if (!cNeg.ok) {
      return { ok: false, injected: false, fired: false,
               note: `self-guard FAILED: could not build negative archive (tar): ${cNeg.error}` };
    }
    const negList = listEntries(negPath);
    const injected = negList.ok && !negList.entries.includes(m.sentinel_name); // bad input provably present
    const vNeg = verifyArchive(negPath, expected);
    const fired = vNeg.ok === false && (vNeg.missing || []).includes(m.sentinel_name); // caught the miss

    const ok = vPos.ok && injected && fired;
    return {
      ok, injected, fired,
      note: ok
        ? `self-guard OK: positive archive verified (${vPos.entries} entries, sha ${vPos.sha256.slice(0, 12)}…, ` +
          `extractable, stable); negative archive omitting '${m.sentinel_name}' was CAUGHT (${vNeg.reason})`
        : `self-guard FAILED: positive=${vPos.reason}; negative injected=${injected} fired=${fired} (${vNeg.reason})`,
    };
  } catch (e) {
    return { ok: false, injected: false, fired: false, note: `self-guard error: ${e.message}` };
  } finally {
    for (const d of [stage, posDir, negDir]) {
      try { if (d) rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

function tsName(prefix) {
  return prefix + new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "Z") + ".tar.gz";
}

function dryRun(target) {
  const r = new Result(CONTROL, SURFACE, TITLE);
  const sg = selfGuard();
  r.negativeControl({ injected: sg.injected, fired: sg.fired, note: sg.note });
  if (!sg.ok) {
    return r.set("unknown", { evidence: sg.note,
      message: "backup verifier self-guard failed — verdict not trustworthy" });
  }

  const m = loadManifest();
  const expected = walkTree(target, { exclude: m.exclude }).map((e) => e.rel);
  if (expected.length === 0) {
    return r.set("unknown", {
      evidence: `target ${target} has 0 in-scope files (after excludes) — nothing to back up or unreadable`,
      message: "backup: nothing to archive at target (unverifiable)" });
  }

  const outDir = mkTmpDir("hygiene-bkp-dry-");
  const outPath = join(outDir, "dryrun.tar.gz");
  try {
    const c = createArchive(target, outPath, m.exclude);
    if (!c.ok) {
      return r.set("unknown", { evidence: `tar could not build a trial archive: ${c.error}`,
        message: "backup: archive tooling failed (unverifiable)" });
    }
    const v = verifyArchive(outPath, expected);
    r.detail({ mode: "dry-run", would_write_to: m.output_dir, expected_files: expected.length,
               archive_entries: v.entries, sha256: v.sha256, stable: v.stable,
               extractable: v.extractable, missing: v.missing });
    if (!v.ok) {
      return r.set("fail", {
        evidence: `trial archive of ${target} did NOT verify: ${v.reason}`,
        message: "backup: archive failed verification (would not be a safe backup)" });
    }
    return r.set("pass", {
      evidence: `trial archive verified: ${v.entries} entries capture all ${expected.length} in-scope ` +
                `file(s), sha256 stable (${v.sha256.slice(0, 12)}…), extractable. DRY-RUN — nothing written. ` +
                `Re-run with --apply to write into ${m.output_dir}. ${sg.note}`,
      message: "backup: archive builds and verifies (dry-run; --apply to write)" });
  } finally {
    try { rmSync(outDir, { recursive: true, force: true }); } catch { /* */ }
  }
}

function apply(target) {
  const r = new Result(CONTROL, SURFACE, TITLE);
  const sg = selfGuard();
  r.negativeControl({ injected: sg.injected, fired: sg.fired, note: sg.note });
  if (!sg.ok) {
    return r.set("unknown", { evidence: sg.note,
      message: "backup verifier self-guard failed — refusing to declare a verified backup" });
  }

  const m = loadManifest();
  const expected = walkTree(target, { exclude: m.exclude }).map((e) => e.rel);
  if (expected.length === 0) {
    return r.set("unknown", {
      evidence: `target ${target} has 0 in-scope files (after excludes) — nothing to back up or unreadable`,
      message: "backup: nothing to archive at target (unverifiable)" });
  }

  const outDir = join(target, m.output_dir);
  mkdirSync(outDir, { recursive: true });
  const archivePath = join(outDir, tsName(m.archive_prefix));

  const c = createArchive(target, archivePath, m.exclude);
  if (!c.ok) {
    return r.set("unknown", { evidence: `tar could not write the archive: ${c.error}`,
      message: "backup --apply: archive tooling failed (no backup written)" });
  }

  // Re-verify the on-disk archive AFTER writing, before declaring success.
  const v = verifyArchive(archivePath, expected);
  const sha = sha256File(archivePath);
  writeFileSync(archivePath + ".sha256", `${sha}  ${archivePath.split("/").pop()}\n`);
  const listed = listEntries(archivePath);
  writeFileSync(archivePath + ".manifest.txt", (listed.entries || []).join("\n") + "\n");

  r.detail({ mode: "apply", archive: archivePath, sha256: sha, expected_files: expected.length,
             archive_entries: v.entries, stable: v.stable, extractable: v.extractable, missing: v.missing });

  if (!v.ok) {
    return r.set("fail", {
      evidence: `wrote ${archivePath} but RE-VERIFY failed: ${v.reason} — do not trust this archive`,
      message: "backup --apply: written archive did not verify (NOT a safe backup)" });
  }

  // Off-system copy reminder (the human-gated P2 step). Printed to stderr so it
  // never contaminates the machine JSON on stdout.
  process.stderr.write(
    `\n  [backup] wrote & verified ${archivePath}\n` +
    `  [backup] sha256: ${sha}\n` +
    `  [backup] P2 (human): copy this archive OFF-SYSTEM (it is not a backup until it ` +
    `lives somewhere this host can fail without taking it down).\n\n`);

  return r.set("pass", {
    evidence: `wrote ${archivePath} (+ .sha256, .manifest.txt) and RE-VERIFIED from disk: ` +
              `${v.entries} entries capture all ${expected.length} in-scope file(s), sha256 stable, ` +
              `extractable. Off-system copy reminder printed. ${sg.note}`,
    message: "backup --apply: archive written and verified (remember the off-system copy)" });
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
  return emitResult(dryRun(target));
}

process.exit(main(process.argv.slice(2)));
