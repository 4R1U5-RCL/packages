#!/usr/bin/env node
// rls.mjs — CONTROL: rls   SURFACE: repo
//
// Asserts: every app-data table created in the migration set has row-level
// security enabled. A table created without `enable row level security` is a
// data-exposure finding (the class Tessera DEFECT-1 lived next to).
//
// THE REFERENCE CHECK — the shape every other check follows:
//
//   1. Read the FIXED manifest (manifests/rls.json) for what to audit. The
//      audited surface is never model discretion (WORKING_METHOD §1).
//   2. SELF-GUARD FIRST (WORKING_METHOD §7/§8). Before trusting any verdict on
//      the real target, prove the check still works:
//        - detection on fixtures/rls/bad  MUST find the injected violation
//          (negative control FIRES) and confirm the bad input is present,
//        - detection on fixtures/rls/good MUST find zero violations (guards
//          against a check that flags everything / false-positives).
//      If the self-guard does not hold, the check is broken: emit `unknown`,
//      never a pass. A green from a broken check is what this package exists to
//      prevent.
//   3. Only with a fired negative control do we run the real target. _common.mjs
//      structurally downgrades a pass without a fired negative control.
//
// Run:  node rls.mjs --target /path/to/repo
//       node rls.mjs --self-test

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import * as sql from "./_sqlutil.mjs";
import { Result, emitResult } from "./_common.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const MANIFEST = join(PKG, "manifests", "rls.json");
const FIX_GOOD = join(PKG, "fixtures", "rls", "good");
const FIX_BAD = join(PKG, "fixtures", "rls", "bad");

const CONTROL = "rls";
const SURFACE = "repo";

function loadGlobs() {
  return JSON.parse(readFileSync(MANIFEST, "utf8")).globs;
}

function findViolations(root, globs) {
  const files = sql.gatherFiles(root, globs);
  const violations = [];
  let tablesSeen = 0;
  for (const [path, text] of sql.readConcat(files)) {
    const norm = sql.normalize(text);
    for (const table of [...sql.createdTables(norm)].sort()) {
      tablesSeen++;
      if (!sql.tableHasRls(norm, table)) {
        violations.push([relative(root, path), table]);
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
  const globs = loadGlobs();
  let bad, good;
  try { bad = findViolations(FIX_BAD, globs); good = findViolations(FIX_GOOD, globs); }
  catch (e) { return { ok: false, injected: false, fired: false,
                       note: `fixtures unreadable: ${e.message}` }; }
  // injected: the bad fixture was actually parsed AND contains a table missing
  // RLS (the bad input is provably present, not an empty/unmatched scan).
  const injected = bad.tablesSeen >= 1 && bad.violations.length >= 1;
  const fired = bad.violations.length >= 1;   // our detector flagged it
  const clean = good.tablesSeen >= 1 && good.violations.length === 0; // good parsed & clean
  if (!injected) {
    return { ok: false, injected, fired,
             note: `self-guard FAILED: bad fixture parsed ${bad.tablesSeen} table(s), ` +
                   `${bad.violations.length} violation(s) — negative control could not ` +
                   `be injected (expected a missing-RLS table)` };
  }
  if (!clean) {
    return { ok: false, injected, fired,
             note: `self-guard FAILED: good fixture parsed ${good.tablesSeen} table(s) ` +
                   `with ${good.violations.length} violation(s) — check false-positives ` +
                   `or did not parse, cannot trust it` };
  }
  return { ok: true, injected, fired,
           note: `self-guard OK: bad fixture flagged ` +
                 `${JSON.stringify(bad.violations)}, good fixture clean ` +
                 `(${good.tablesSeen} tables, 0 violations)` };
}

function run(target) {
  const r = new Result(CONTROL, SURFACE);
  const sg = selfGuard();
  r.negativeControl({ injected: sg.injected, fired: sg.fired, note: sg.note });
  if (!sg.ok) {
    return r.set("unknown", { evidence: sg.note,
      message: "RLS check self-guard failed — verdict not trustworthy" });
  }

  const globs = loadGlobs();
  const { violations, tablesSeen, nFiles } = findViolations(target, globs);
  if (tablesSeen === 0) {
    return r.set("unknown", {
      evidence: `manifest globs matched ${nFiles} file(s) under ${target} but ` +
                `found 0 created tables — nothing to audit; check target path/globs`,
      message: "RLS: no tables found at target (unverifiable)" });
  }
  if (violations.length) {
    const listed = violations.map(([f, t]) => `${f}:${t}`).join("; ");
    return r.set("fail", {
      evidence: `${violations.length} table(s) without RLS across ${nFiles} file(s): ${listed}`,
      message: `RLS missing on ${violations.length} table(s)` });
  }
  return r.set("pass", {
    evidence: `all ${tablesSeen} created table(s) across ${nFiles} file(s) enable ` +
              `row level security; ${sg.note}`,
    message: "RLS present on every app-data table" });
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
