#!/usr/bin/env node
// app-logging.mjs — CONTROL: app-logging   SURFACE: app   REACHABILITY: static
//
// Asserts: the app WIRES security-event logging into its auth paths. Within the
// files matched by the auth globs there must be >=1 invocation of a recognized
// security-logging sink. Auth code that emits no security events leaves the
// audit trail an attacker operates beneath (OWASP A09).
//
// HONEST LIMIT (manifest note): this verifies the WIRING is present — a logging
// sink is called — not the completeness/quality of what is logged.
//
// Mirrors rls.mjs (THE reference): read the FIXED manifest, SELF-GUARD FIRST via
// the SAME detector path used on the real target, then judge the target. A pass
// is only emitted when the negative control actually fired; _common.mjs
// structurally downgrades any unwatched pass to "unknown".
//
// Run:  node app-logging.mjs --target /path/to/repo
//       node app-logging.mjs --self-test
//
// Node 22 built-ins only. Zero npm deps.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { gatherFiles } from "./_sqlutil.mjs";
import { Result, emitResult } from "./_common.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const MANIFEST = join(PKG, "manifests", "app-logging.json");
const FIX_GOOD = join(PKG, "fixtures", "app-logging", "good");
const FIX_BAD = join(PKG, "fixtures", "app-logging", "bad");

const CONTROL = "app-logging";
const SURFACE = "app";
const REACHABILITY = "static";

// A recognized security-logging sink invocation.
const SINK = /\b(logSecurityEvent|logAuthEvent|auditLog|securityLog|logSecurity)\s*\(/;

function loadGlobs() {
  return JSON.parse(readFileSync(MANIFEST, "utf8")).globs;
}

// DETECTION — gather auth files via the manifest globs and find logging-sink
// invocations. Returns { nFiles, hits } where hits lists [file, sinkName].
function detect(root, globs) {
  const files = gatherFiles(root, globs);
  const hits = [];
  for (const [path, text] of readAll(files)) {
    const m = text.match(SINK);
    if (m) hits.push([relative(root, path), m[1]]);
  }
  return { nFiles: files.length, hits };
}

function readAll(paths) {
  const out = [];
  for (const p of paths) {
    try { out.push([p, readFileSync(p, "utf8")]); } catch { /* skip unreadable */ }
  }
  return out;
}

// Self-guard runs the SAME detect() path used on real targets against the
// bundled fixtures. The bad fixture MUST have auth files scanned with ZERO
// logging calls (negative control fires as fail) and the good fixture MUST have
// >=1 sink call (guards against a check that flags everything / never passes).
function selfGuard() {
  const globs = loadGlobs();
  let bad, good;
  try { bad = detect(FIX_BAD, globs); good = detect(FIX_GOOD, globs); }
  catch (e) { return { ok: false, injected: false, fired: false,
                       note: `fixtures unreadable: ${e.message}` }; }
  // injected: bad fixture had auth files scanned (>=1) AND zero logging calls —
  // the deliberately-bad "no logging wired" condition is provably present.
  const injected = bad.nFiles >= 1 && bad.hits.length === 0;
  const fired = bad.hits.length === 0;             // detector returns fail on bad
  const clean = good.nFiles >= 1 && good.hits.length >= 1; // good scanned & has logging
  if (!injected) {
    return { ok: false, injected, fired,
      note: `self-guard FAILED: bad fixture scanned ${bad.nFiles} auth file(s), ` +
            `${bad.hits.length} logging call(s) — negative control could not be injected ` +
            `(expected auth files with NO security-logging call)` };
  }
  if (!clean) {
    return { ok: false, injected, fired,
      note: `self-guard FAILED: good fixture scanned ${good.nFiles} auth file(s) with ` +
            `${good.hits.length} logging call(s) — check did not recognize the sink, ` +
            `cannot trust it` };
  }
  return { ok: true, injected, fired,
    note: `self-guard OK: bad fixture scanned ${bad.nFiles} auth file(s) with 0 logging, ` +
          `good fixture flagged sink ${JSON.stringify(good.hits[0])}` };
}

function run(target) {
  const r = new Result(CONTROL, SURFACE, REACHABILITY);
  const sg = selfGuard();
  r.negativeControl({ injected: sg.injected, fired: sg.fired, note: sg.note });
  if (!sg.ok) {
    return r.set("unknown", { evidence: sg.note,
      message: "app-logging check self-guard failed — verdict not trustworthy" });
  }

  const globs = loadGlobs();
  const { nFiles, hits } = detect(target, globs);
  if (nFiles === 0) {
    return r.set("unknown", {
      evidence: `manifest globs matched 0 file(s) under ${target} — no auth code found ` +
                `to audit; check target path/globs`,
      message: "app-logging: no auth code found to audit at target (unverifiable)" });
  }
  if (hits.length === 0) {
    return r.set("fail", {
      evidence: `${nFiles} auth file(s) scanned but 0 security-logging-sink call(s) found ` +
                `(${SINK.source})`,
      message: "app-logging: auth code present but no security-event logging wired" });
  }
  const listed = hits.map(([f, s]) => `${f}:${s}`).join("; ");
  return r.set("pass", {
    evidence: `${nFiles} auth file(s) scanned; ${hits.length} security-logging-sink ` +
              `call(s): ${listed}; ${sg.note}`,
    message: "app-logging: security-event logging wired into auth paths" });
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
