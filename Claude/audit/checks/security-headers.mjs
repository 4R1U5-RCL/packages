#!/usr/bin/env node
// security-headers.mjs — CONTROL: security-headers   SURFACE: app   REACHABILITY: static
//
// Asserts: the delivered Next.js app configures the required security RESPONSE
// headers (CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy).
// A header config that ships with one of these missing is an OWASP A05
// misconfiguration finding — the browser is left un-hardened against drive-by
// compromise and injected script.
//
// Mirrors rls.mjs (THE reference): read the FIXED manifest, SELF-GUARD FIRST via
// the SAME detector path used on the real target, then judge the target. A pass
// is only emitted when the negative control actually fired; _common.mjs
// structurally downgrades any unwatched pass to "unknown".
//
// Run:  node security-headers.mjs --target /path/to/repo
//       node security-headers.mjs --self-test
//
// Node 22 built-ins only. Zero npm deps.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { gatherFiles } from "./_sqlutil.mjs";
import { Result, emitResult } from "./_common.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const MANIFEST = join(PKG, "manifests", "security-headers.json");
const FIX_GOOD = join(PKG, "fixtures", "security-headers", "good");
const FIX_BAD = join(PKG, "fixtures", "security-headers", "bad");

const CONTROL = "security-headers";
const SURFACE = "app";
const REACHABILITY = "static";

// The five required security response header NAMES (lowercased for matching).
const REQUIRED = [
  "content-security-policy",
  "strict-transport-security",
  "x-frame-options",
  "x-content-type-options",
  "referrer-policy",
];

function loadGlobs() {
  return JSON.parse(readFileSync(MANIFEST, "utf8")).globs;
}

// DETECTION — gather the app's header-config files via the manifest globs,
// concatenate their text (lowercased), and confirm each required header NAME
// appears. Returns { nFiles, present, missing } so a finding lists the gaps.
function detect(root, globs) {
  const files = gatherFiles(root, globs);
  let blob = "";
  for (const [, text] of readAll(files)) blob += "\n" + text.toLowerCase();
  const present = REQUIRED.filter((h) => blob.includes(h));
  const missing = REQUIRED.filter((h) => !blob.includes(h));
  return { nFiles: files.length, present, missing };
}

function readAll(paths) {
  const out = [];
  for (const p of paths) {
    try { out.push([p, readFileSync(p, "utf8")]); } catch { /* skip unreadable */ }
  }
  return out;
}

// Self-guard runs the SAME detect() path used on real targets against the
// bundled fixtures (laid out so the globs match). The bad fixture MUST be a
// scanned config missing >=1 required header (negative control fires) and the
// good fixture MUST set all five (guards against a check that flags everything).
function selfGuard() {
  const globs = loadGlobs();
  let bad, good;
  try { bad = detect(FIX_BAD, globs); good = detect(FIX_GOOD, globs); }
  catch (e) { return { ok: false, injected: false, fired: false,
                       note: `fixtures unreadable: ${e.message}` }; }
  // injected: bad fixture had a config file scanned AND is missing >=1 header.
  const injected = bad.nFiles >= 1 && bad.missing.length >= 1;
  const fired = bad.missing.length >= 1;            // our detector flagged it (fail)
  const clean = good.nFiles >= 1 && good.missing.length === 0; // good scanned & complete
  if (!injected) {
    return { ok: false, injected, fired,
      note: `self-guard FAILED: bad fixture scanned ${bad.nFiles} config file(s), ` +
            `missing ${JSON.stringify(bad.missing)} — negative control could not be ` +
            `injected (expected a scanned config missing >=1 required header)` };
  }
  if (!clean) {
    return { ok: false, injected, fired,
      note: `self-guard FAILED: good fixture scanned ${good.nFiles} config file(s), ` +
            `missing ${JSON.stringify(good.missing)} — check false-positives or did not ` +
            `parse, cannot trust it` };
  }
  return { ok: true, injected, fired,
    note: `self-guard OK: bad fixture missing ${JSON.stringify(bad.missing)}, ` +
          `good fixture sets all ${REQUIRED.length} headers (${good.nFiles} config file(s))` };
}

function run(target) {
  const r = new Result(CONTROL, SURFACE, REACHABILITY);
  const sg = selfGuard();
  r.negativeControl({ injected: sg.injected, fired: sg.fired, note: sg.note });
  if (!sg.ok) {
    return r.set("unknown", { evidence: sg.note,
      message: "security-headers check self-guard failed — verdict not trustworthy" });
  }

  const globs = loadGlobs();
  const { nFiles, present, missing } = detect(target, globs);
  if (nFiles === 0) {
    return r.set("unknown", {
      evidence: `manifest globs matched 0 file(s) under ${target} — no app header ` +
                `config found at target; check target path/globs`,
      message: "security-headers: no app header config found at target (unverifiable)" });
  }
  if (missing.length) {
    return r.set("fail", {
      evidence: `${nFiles} header-config file(s) scanned; present ${JSON.stringify(present)}, ` +
                `MISSING ${JSON.stringify(missing)}`,
      message: `security-headers: ${missing.length} required header(s) missing` });
  }
  return r.set("pass", {
    evidence: `${nFiles} header-config file(s) scanned; all ${REQUIRED.length} required ` +
              `headers present ${JSON.stringify(present)}; ${sg.note}`,
    message: "security-headers: all five required response headers configured" });
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
