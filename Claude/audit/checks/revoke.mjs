#!/usr/bin/env node
// revoke.mjs — CONTROL: revoke   SURFACE: repo
//
// Asserts: every PII table in the migration set has its baseline grants REVOKEd
// from BOTH `anon` AND `public` (before any explicit grant). A PII table created
// without those revokes is readable behind a fine-looking RLS policy — the
// Tessera DEFECT-1 class (a permission leak the loose default grant let through).
//
// Mirrors rls.mjs structurally (the reference check); only the detector differs:
//
//   1. Read the FIXED manifest (manifests/revoke.json) for what to audit and the
//      PII set (revoke_required). The audited surface is never model discretion
//      (WORKING_METHOD §1).
//   2. SELF-GUARD FIRST (WORKING_METHOD §7/§8). Before trusting any verdict on
//      the real target, prove the check still works:
//        - detection on fixtures/revoke/bad  MUST find the injected violation
//          (negative control FIRES) and confirm the bad input is present,
//        - detection on fixtures/revoke/good MUST find zero violations (guards
//          against a check that flags everything / false-positives).
//      If the self-guard does not hold, the check is broken: emit `unknown`,
//      never a pass.
//   3. Only with a fired negative control do we run the real target. _common.mjs
//      structurally downgrades a pass without a fired negative control.
//
// Run:  node revoke.mjs --target /path/to/repo
//       node revoke.mjs --self-test

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import * as sql from "./_sqlutil.mjs";
import { Result, emitResult } from "./_common.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const MANIFEST = join(PKG, "manifests", "revoke.json");
const FIX_GOOD = join(PKG, "fixtures", "revoke", "good");
const FIX_BAD = join(PKG, "fixtures", "revoke", "bad");

const CONTROL = "revoke";
const SURFACE = "repo";

// Baseline grants must be stripped from BOTH of these for every PII table.
const REQUIRED_ROLES = ["anon", "public"];

function loadManifest() {
  const m = JSON.parse(readFileSync(MANIFEST, "utf8"));
  return { globs: m.globs, revokeRequired: m.revoke_required };
}

function findViolations(root, globs, revokeRequired) {
  const files = sql.gatherFiles(root, globs);
  const required = new Set(revokeRequired);
  const violations = [];
  let tablesSeen = 0; // PII tables actually created in the target
  for (const [path, text] of sql.readConcat(files)) {
    const norm = sql.normalize(text);
    for (const table of [...sql.createdTables(norm)].sort()) {
      if (!required.has(table)) continue; // only audit the PII set
      tablesSeen++;
      const roles = sql.revokesForTable(norm, table);
      const missing = REQUIRED_ROLES.filter((r) => !roles.has(r));
      if (missing.length) {
        violations.push([relative(root, path), table, missing]);
      }
    }
  }
  return { violations, tablesSeen, nFiles: files.length };
}

// Self-guard runs the SAME findViolations() path used on real targets, against
// the bundled fixtures (laid out to mirror a real repo so the manifest globs
// match). Exercising the real code path — not a parallel one — is the point:
// the negative control proves the exact detector that judges production still
// catches a known-bad input.
// Returns { ok, injected, fired, note }. ok=false => check is broken.
function selfGuard() {
  const { globs, revokeRequired } = loadManifest();
  let bad, good;
  try {
    bad = findViolations(FIX_BAD, globs, revokeRequired);
    good = findViolations(FIX_GOOD, globs, revokeRequired);
  } catch (e) {
    return { ok: false, injected: false, fired: false,
             note: `fixtures unreadable: ${e.message}` };
  }
  // injected: the bad fixture was actually parsed AND contains a PII table
  // missing its anon+public revoke (the bad input is provably present, not an
  // empty/unmatched scan).
  const injected = bad.tablesSeen >= 1 && bad.violations.length >= 1;
  const fired = bad.violations.length >= 1;   // our detector flagged it
  const clean = good.tablesSeen >= 1 && good.violations.length === 0; // good parsed & clean
  if (!injected) {
    return { ok: false, injected, fired,
             note: `self-guard FAILED: bad fixture parsed ${bad.tablesSeen} PII table(s), ` +
                   `${bad.violations.length} violation(s) — negative control could not ` +
                   `be injected (expected a PII table missing anon+public revoke)` };
  }
  if (!clean) {
    return { ok: false, injected, fired,
             note: `self-guard FAILED: good fixture parsed ${good.tablesSeen} PII table(s) ` +
                   `with ${good.violations.length} violation(s) — check false-positives ` +
                   `or did not parse, cannot trust it` };
  }
  return { ok: true, injected, fired,
           note: `self-guard OK: bad fixture flagged ` +
                 `${JSON.stringify(bad.violations)}, good fixture clean ` +
                 `(${good.tablesSeen} PII tables, 0 violations)` };
}

function run(target) {
  const r = new Result(CONTROL, SURFACE);
  const sg = selfGuard();
  r.negativeControl({ injected: sg.injected, fired: sg.fired, note: sg.note });
  if (!sg.ok) {
    return r.set("unknown", { evidence: sg.note,
      message: "REVOKE check self-guard failed — verdict not trustworthy" });
  }

  const { globs, revokeRequired } = loadManifest();
  const { violations, tablesSeen, nFiles } = findViolations(target, globs, revokeRequired);
  if (tablesSeen === 0) {
    return r.set("unknown", {
      evidence: `manifest globs matched ${nFiles} file(s) under ${target} but ` +
                `found 0 created PII tables (of ${JSON.stringify(revokeRequired)}) — ` +
                `nothing to audit; check target path/globs`,
      message: "REVOKE: no PII tables found at target (unverifiable)" });
  }
  if (violations.length) {
    const listed = violations
      .map(([f, t, missing]) => `${f}:${t} (missing revoke from ${missing.join("+")})`)
      .join("; ");
    return r.set("fail", {
      evidence: `${violations.length} PII table(s) without anon+public REVOKE across ` +
                `${nFiles} file(s): ${listed}`,
      message: `REVOKE discipline missing on ${violations.length} PII table(s)` });
  }
  return r.set("pass", {
    evidence: `all ${tablesSeen} PII table(s) across ${nFiles} file(s) revoke baseline ` +
              `grants from anon AND public; ${sg.note}`,
    message: "REVOKE discipline present on every PII table" });
}

function main(argv) {
  const target = (() => {
    const i = argv.indexOf("--target");
    return i >= 0 ? argv[i + 1] : process.cwd();
  })();
  if (argv.includes("--self-test")) {
    const sg = selfGuard();
    console.log(JSON.stringify({ control: CONTROL, self_guard_ok: sg.ok,
      injected: sg.injected, fired: sg.fired, note: sg.note }));
    return sg.ok ? 0 : 2;
  }
  return emitResult(run(target));
}

process.exit(main(process.argv.slice(2)));
