#!/usr/bin/env node
// dependency-audit.mjs — CONTROL: dependency-audit   SURFACE: app   REACHABILITY: static
//
// Asserts: dependency-CVE alerting is CONFIGURED for the repo — either a
// `.github/dependabot.yml` with an `updates:` block and `package-ecosystem`, or
// a GitHub Actions workflow that runs a software-composition-analysis (SCA) step
// (dependabot / dependency-review / npm audit / pnpm audit / osv-scanner / snyk /
// trivy). Absence of any such alerting in a readable repo IS the finding (OWASP
// A06) — a known CVE in a transitive dependency would go unnoticed.
//
// Mirrors rls.mjs (THE reference): read the FIXED manifest, SELF-GUARD FIRST via
// the SAME detector path used on the real target, then judge the target. A pass
// is only emitted when the negative control actually fired; _common.mjs
// structurally downgrades any unwatched pass to "unknown".
//
// Run:  node dependency-audit.mjs --target /path/to/repo
//       node dependency-audit.mjs --self-test
//
// Node 22 built-ins only. Zero npm deps.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, basename } from "node:path";
import { gatherFiles } from "./_sqlutil.mjs";
import { Result, emitResult } from "./_common.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const MANIFEST = join(PKG, "manifests", "dependency-audit.json");
const FIX_GOOD = join(PKG, "fixtures", "dependency-audit", "good");
const FIX_BAD = join(PKG, "fixtures", "dependency-audit", "bad");

const CONTROL = "dependency-audit";
const SURFACE = "app";
const REACHABILITY = "static";

// SCA step markers — any of these in a workflow file qualifies it as alerting.
const SCA_MARKERS = [
  "dependabot",
  "dependency-review",
  "npm audit",
  "pnpm audit",
  "osv-scanner",
  "snyk",
  "trivy",
];

function loadGlobs() {
  return JSON.parse(readFileSync(MANIFEST, "utf8")).globs;
}

// True iff the target path is readable as a directory. Distinguishes an
// unreadable target (-> unknown) from a readable repo with no alerting (-> fail).
function targetReadable(root) {
  try { readdirSync(root); return true; } catch { return false; }
}

// DETECTION — gather candidate files via the manifest globs and decide whether
// any qualifies as configured dependency-CVE alerting:
//   - a dependabot.{yml,yaml} containing `updates:` AND `package-ecosystem`, OR
//   - a workflow file containing any SCA marker.
// Returns { nFiles, qualified } where qualified lists [file, reason].
function detect(root, globs) {
  const files = gatherFiles(root, globs);
  const qualified = [];
  for (const [path, text] of readAll(files)) {
    const rel = relative(root, path);
    const low = text.toLowerCase();
    const name = basename(path).toLowerCase();
    if (name === "dependabot.yml" || name === "dependabot.yaml") {
      if (low.includes("updates:") && low.includes("package-ecosystem")) {
        qualified.push([rel, "dependabot config (updates + package-ecosystem)"]);
        continue;
      }
    }
    const marker = SCA_MARKERS.find((m) => low.includes(m));
    if (marker) qualified.push([rel, `SCA step "${marker}"`]);
  }
  return { nFiles: files.length, qualified };
}

function readAll(paths) {
  const out = [];
  for (const p of paths) {
    try { out.push([p, readFileSync(p, "utf8")]); } catch { /* skip unreadable */ }
  }
  return out;
}

// Self-guard runs the SAME detect() path used on real targets against the
// bundled fixtures. The bad fixture MUST have a .github tree scanned with zero
// qualifying alerting (negative control fires as fail) and the good fixture MUST
// have a qualifying source (guards against a check that passes nothing).
function selfGuard() {
  const globs = loadGlobs();
  let bad, good;
  try { bad = detect(FIX_BAD, globs); good = detect(FIX_GOOD, globs); }
  catch (e) { return { ok: false, injected: false, fired: false,
                       note: `fixtures unreadable: ${e.message}` }; }
  // injected: bad fixture had its .github tree scanned (>=1 file) AND nothing
  // qualifies — the deliberately-bad "no alerting" condition is provably present.
  const injected = bad.nFiles >= 1 && bad.qualified.length === 0;
  const fired = bad.qualified.length === 0;            // detector returns fail on bad
  const clean = good.qualified.length >= 1;            // good has qualifying alerting
  if (!injected) {
    return { ok: false, injected, fired,
      note: `self-guard FAILED: bad fixture scanned ${bad.nFiles} file(s), ` +
            `${bad.qualified.length} qualifying source(s) — negative control could not be ` +
            `injected (expected a .github tree with NO dependency-alerting)` };
  }
  if (!clean) {
    return { ok: false, injected, fired,
      note: `self-guard FAILED: good fixture has ${good.qualified.length} qualifying ` +
            `source(s) — check could not recognize valid alerting, cannot trust it` };
  }
  return { ok: true, injected, fired,
    note: `self-guard OK: bad fixture scanned ${bad.nFiles} file(s) with 0 alerting, ` +
          `good fixture qualified via ${JSON.stringify(good.qualified[0])}` };
}

function run(target) {
  const r = new Result(CONTROL, SURFACE, REACHABILITY);
  const sg = selfGuard();
  r.negativeControl({ injected: sg.injected, fired: sg.fired, note: sg.note });
  if (!sg.ok) {
    return r.set("unknown", { evidence: sg.note,
      message: "dependency-audit check self-guard failed — verdict not trustworthy" });
  }

  // Only an unreadable target is "unknown" — absence of alerting in a READABLE
  // repo is itself a provable finding (fail), per the manifest note.
  if (!targetReadable(target)) {
    return r.set("unknown", {
      evidence: `target path ${target} is unreadable — cannot scan for dependency alerting`,
      message: "dependency-audit: target unreadable (unverifiable)" });
  }

  const globs = loadGlobs();
  const { nFiles, qualified } = detect(target, globs);
  if (qualified.length) {
    const listed = qualified.map(([f, why]) => `${f} (${why})`).join("; ");
    return r.set("pass", {
      evidence: `dependency-CVE alerting configured across ${nFiles} candidate file(s): ` +
                `${listed}; ${sg.note}`,
      message: "dependency-audit: dependency-CVE alerting configured" });
  }
  return r.set("fail", {
    evidence: `${nFiles} candidate file(s) under .github at ${target} but none configures ` +
              `dependency-CVE alerting (no dependabot updates block, no SCA workflow step)`,
    message: "dependency-audit: no dependency-CVE alerting configured" });
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
