#!/usr/bin/env node
// matrix-freshness.mjs — CONTROL: matrix-freshness   SURFACE: infra
//
// THE META-CONTROL. Asserts: the ATT&CK version this package pins in
// mapping/ATTACK_VERSION still matches MITRE's CURRENT published Enterprise
// release. Every other check cites ATT&CK technique IDs out of
// mapping/controls.json; if MITRE has moved on (renamed/renumbered/retired
// techniques) those citations silently rot. This control is the only thing
// that keeps the whole ATT&CK mapping honest — so it is also the purest test of
// the honest-pass discipline: a network blip must NEVER read as "current".
//
// Mirrors rls.mjs (the reference) structurally:
//   1. Read the FIXED pin (mapping/ATTACK_VERSION) — pinned version + domain +
//      live poll source. What we compare against is not model discretion.
//   2. SELF-GUARD FIRST (WORKING_METHOD §7/§8). Before trusting any verdict on
//      the live feed, prove the comparator still works against the bundled
//      fixtures:
//        - fixtures/.../bad  advertises an Enterprise version NEWER than pinned;
//          the comparator MUST flag it stale (negative control FIRES) and the
//          drift MUST be provably present (injected).
//        - fixtures/.../good advertises Enterprise == pinned AND carries a decoy
//          non-Enterprise collection with a HIGHER number; the comparator MUST
//          return "current" — proving it selects "Enterprise ATT&CK", not
//          collections[0] and not the global max.
//      If the self-guard does not hold, the comparator is broken: emit
//      `unknown`, never a pass.
//   3. Only with a fired negative control do we judge the live feed. _common.mjs
//      structurally downgrades a pass without a fired negative control.
//
// Status vocabulary for THIS control:
//   pass     "confirmed current"  — published Enterprise == pinned
//   fail     "confirmed stale"    — published Enterprise > pinned (names the gap)
//   unknown  "couldn't verify"    — network error / parse miss / shape miss /
//            source unreachable / pin ahead of published. NEVER a silent pass.
//
// A stale result is a MAINTENANCE finding (review changed technique IDs and
// re-map mapping/controls.json + bump ATTACK_VERSION) — NOT a deploy/build
// blocker. This control gates the audit's own currency, not a client build.
//
// Run:  node matrix-freshness.mjs                       (live fetch of the pin)
//       node matrix-freshness.mjs --source <fileOrUrl>  (override, e.g. fixture)
//       node matrix-freshness.mjs --self-test           (JSON, exit 0/2)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Result, emitResult } from "./_common.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const ATTACK_VERSION = join(PKG, "mapping", "ATTACK_VERSION");
const FIX_GOOD = join(PKG, "fixtures", "matrix-freshness", "good", "index.json");
const FIX_BAD = join(PKG, "fixtures", "matrix-freshness", "bad", "index.json");

const CONTROL = "matrix-freshness";
const SURFACE = "infra";
const ENTERPRISE_NAME = "Enterprise ATT&CK";

// ---- version algebra (numeric major.minor; null on anything unparseable) ----
function parseVer(s) {
  if (typeof s !== "string" && typeof s !== "number") return null;
  const m = String(s).trim().match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) return null;
  return [Number(m[1]), m[2] === undefined ? 0 : Number(m[2])];
}
function cmpVer(a, b) {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  return 0;
}

// Select the Enterprise collection (NOT collections[0], NOT the global max) and
// take the greatest of its versions[]. Guards every shape assumption.
function extractEnterpriseVersion(index) {
  if (!index || typeof index !== "object" || !Array.isArray(index.collections)) {
    return { ok: false, reason: "source JSON has no top-level collections[] array" };
  }
  const ent = index.collections.find((c) => c && c.name === ENTERPRISE_NAME);
  if (!ent) {
    const names = index.collections.map((c) => (c && c.name) || "?").join(", ");
    return { ok: false, reason: `no collection named "${ENTERPRISE_NAME}" (saw: ${names})` };
  }
  if (!Array.isArray(ent.versions) || ent.versions.length === 0) {
    return { ok: false, reason: `"${ENTERPRISE_NAME}" collection has no versions[] entries` };
  }
  let best = null, bestRaw = null;
  for (const v of ent.versions) {
    const p = parseVer(v && v.version);
    if (!p) continue;
    if (best === null || cmpVer(p, best) > 0) { best = p; bestRaw = String(v.version).trim(); }
  }
  if (best === null) {
    return { ok: false, reason: `no parseable major.minor version in "${ENTERPRISE_NAME}" versions[]` };
  }
  return { ok: true, version: bestRaw, parsed: best };
}

// PURE comparator — the exact code path used on both the live feed and the
// self-guard fixtures. outcome ∈ current | stale | behind | error.
function freshness(pinnedRaw, index) {
  const pinned = parseVer(pinnedRaw);
  if (!pinned) return { outcome: "error", reason: `pinned version "${pinnedRaw}" is not numeric major.minor` };
  const ex = extractEnterpriseVersion(index);
  if (!ex.ok) return { outcome: "error", reason: ex.reason };
  const c = cmpVer(ex.parsed, pinned);
  if (c === 0) return { outcome: "current", published: ex.version, reason: `published Enterprise ${ex.version} == pinned ${pinnedRaw}` };
  if (c > 0) return { outcome: "stale", published: ex.version, reason: `pinned ${pinnedRaw}, published ${ex.version}` };
  return { outcome: "behind", published: ex.version, reason: `pinned ${pinnedRaw} is NEWER than published ${ex.version}` };
}

function readPin() {
  const raw = JSON.parse(readFileSync(ATTACK_VERSION, "utf8"));
  return { version: raw.version, domain: raw.domain, source: raw.source };
}

// fetch for http(s) URLs (global fetch, Node 22), readFileSync for local paths.
// EVERY failure mode returns { ok:false } — there is no throw-to-pass here.
async function loadIndex(source) {
  if (/^https?:\/\//i.test(source)) {
    let res;
    try { res = await fetch(source, { redirect: "follow" }); }
    catch (e) { return { ok: false, reason: `fetch failed: ${e.message}` }; }
    if (!res.ok) return { ok: false, reason: `fetch returned HTTP ${res.status} ${res.statusText}` };
    let text;
    try { text = await res.text(); }
    catch (e) { return { ok: false, reason: `reading response body failed: ${e.message}` }; }
    try { return { ok: true, data: JSON.parse(text) }; }
    catch (e) { return { ok: false, reason: `response was not valid JSON: ${e.message}` }; }
  }
  let text;
  try { text = readFileSync(source, "utf8"); }
  catch (e) { return { ok: false, reason: `reading file failed: ${e.message}` }; }
  try { return { ok: true, data: JSON.parse(text) }; }
  catch (e) { return { ok: false, reason: `file was not valid JSON: ${e.message}` }; }
}

// Self-guard runs the SAME freshness() comparator used on the live feed against
// the bundled good/bad fixtures. Returns { ok, injected, fired, note }.
//   injected: the bad fixture provably advertises an Enterprise version NEWER
//             than pinned (the drift is really planted, not an empty scan).
//   fired:    the comparator returned "stale" on the bad fixture (it caught it).
//   ok also requires the good fixture to read "current" — which can only happen
//   if Enterprise is selected over the decoy higher-numbered collection,
//   structurally proving we don't take collections[0] or the global max.
function selfGuard(pinnedRaw) {
  let good, bad;
  try {
    good = JSON.parse(readFileSync(FIX_GOOD, "utf8"));
    bad = JSON.parse(readFileSync(FIX_BAD, "utf8"));
  } catch (e) {
    return { ok: false, injected: false, fired: false, note: `fixtures unreadable: ${e.message}` };
  }
  const pinned = parseVer(pinnedRaw);
  const badEx = extractEnterpriseVersion(bad);
  const injected = Boolean(pinned) && badEx.ok && cmpVer(badEx.parsed, pinned) > 0;

  const bv = freshness(pinnedRaw, bad);
  const gv = freshness(pinnedRaw, good);
  const fired = bv.outcome === "stale";
  const goodCurrent = gv.outcome === "current";

  if (!injected) {
    return { ok: false, injected, fired,
      note: `self-guard FAILED: bad fixture does not advertise an Enterprise version newer than ` +
            `pinned ${pinnedRaw} (${badEx.ok ? `got ${badEx.version}` : badEx.reason}) — ` +
            `negative control could not be injected` };
  }
  if (!fired) {
    return { ok: false, injected, fired,
      note: `self-guard FAILED: bad fixture has injected drift (${badEx.version} > ${pinnedRaw}) but ` +
            `the comparator did not flag it stale (outcome=${bv.outcome}) — detector broken` };
  }
  if (!goodCurrent) {
    return { ok: false, injected, fired,
      note: `self-guard FAILED: good fixture (Enterprise == ${pinnedRaw}, with a higher-numbered decoy ` +
            `collection) did not read current (outcome=${gv.outcome}, ${gv.reason}) — comparator is ` +
            `mis-selecting the collection (collections[0]/global-max) or false-positiving` };
  }
  return { ok: true, injected, fired,
    note: `self-guard OK: bad fixture flagged stale (${bv.reason}); good fixture current (${gv.reason}) ` +
          `despite a higher-numbered decoy collection — comparator selects "${ENTERPRISE_NAME}" and detects drift` };
}

async function run(source) {
  const r = new Result(CONTROL, SURFACE);

  let pin;
  try { pin = readPin(); }
  catch (e) {
    r.negativeControl({ injected: false, fired: false, note: `ATTACK_VERSION unreadable: ${e.message}` });
    return r.set("unknown", {
      evidence: `could not read mapping/ATTACK_VERSION: ${e.message}`,
      message: "matrix-freshness: pin file unreadable (unverifiable)" });
  }

  const sg = selfGuard(pin.version);
  r.negativeControl({ injected: sg.injected, fired: sg.fired, note: sg.note });
  if (!sg.ok) {
    return r.set("unknown", { evidence: sg.note,
      message: "matrix-freshness self-guard failed — comparator not trustworthy" });
  }

  const src = source || pin.source;
  const loaded = await loadIndex(src);
  if (!loaded.ok) {
    return r.set("unknown", {
      evidence: `source ${src}: ${loaded.reason}`,
      message: "matrix-freshness: could not reach/parse the ATT&CK feed (NOT a pass — currency unverified)" });
  }

  const f = freshness(pin.version, loaded.data);
  const MAINT = "MAINTENANCE finding (review & re-map) — NOT a deploy/build blocker.";
  if (f.outcome === "current") {
    return r.set("pass", {
      evidence: `confirmed current: ${f.reason}; source=${src}; ${sg.note}`,
      message: `ATT&CK matrix current: Enterprise ${f.published} matches pinned ${pin.version}` });
  }
  if (f.outcome === "stale") {
    return r.set("fail", {
      evidence: `confirmed STALE: ${f.reason}; source=${src}. Review the technique IDs added/renamed/` +
                `retired between ${pin.version} and ${f.published}, re-map mapping/controls.json, then ` +
                `bump mapping/ATTACK_VERSION. ${MAINT}`,
      message: `ATT&CK matrix STALE: pinned ${pin.version}, MITRE published ${f.published}` });
  }
  if (f.outcome === "behind") {
    return r.set("unknown", {
      evidence: `${f.reason}; source=${src} — the pin is AHEAD of the published feed (unexpected: stale ` +
                `source, pre-release pin, or wrong --source). Cannot certify currency.`,
      message: `matrix-freshness: pinned ${pin.version} ahead of published ${f.published} (unverifiable)` });
  }
  return r.set("unknown", {
    evidence: `could not extract the Enterprise version from ${src}: ${f.reason}`,
    message: "matrix-freshness: parse/shape miss — could not verify (NOT a pass)" });
}

async function main(argv) {
  if (argv.includes("--self-test")) {
    let pin;
    try { pin = readPin(); }
    catch (e) {
      console.log(JSON.stringify({ control: CONTROL, ok: false, self_guard_ok: false,
        injected: false, fired: false, note: `ATTACK_VERSION unreadable: ${e.message}` }));
      return 2;
    }
    const sg = selfGuard(pin.version);
    console.log(JSON.stringify({ control: CONTROL, ok: sg.ok, self_guard_ok: sg.ok,
      injected: sg.injected, fired: sg.fired, pinned: pin.version, note: sg.note }));
    return sg.ok ? 0 : 2;
  }
  const source = (() => { const i = argv.indexOf("--source"); return i >= 0 ? argv[i + 1] : null; })();
  return emitResult(await run(source));
}

main(process.argv.slice(2)).then((code) => process.exit(code));
