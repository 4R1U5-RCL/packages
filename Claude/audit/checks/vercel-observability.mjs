#!/usr/bin/env node
// vercel-observability.mjs — CONTROL: vercel-observability   SURFACE: infra
//
// Asserts: the Vercel project has Observability AND the Firewall ENABLED, so the
// deployed app emits telemetry (you can see attacks/anomalies) and has the
// edge firewall standing in front of it (T1190 exploit public-facing app →
// detection + first-line blocking). A "looks fine, isn't" infra gap: the site
// still serves traffic, it just isn't watched or shielded.
//
// SHAPE — mirrors dns-auth.mjs (the reference CONFIG/STATE check):
//
//   1. Read the FIXED manifest (manifests/vercel-observability.json): the set of
//      required boolean keys the STATE DOCUMENT must carry, all true. The audited
//      surface is not model discretion (WORKING_METHOD §1).
//   2. SELF-GUARD FIRST (WORKING_METHOD §7/§8). Before judging any real state,
//      run the EXACT validator against the bundled fixtures:
//        - fixtures/vercel-observability/bad  MUST be flagged fail (negative
//          control FIRES; a required key is genuinely === false),
//        - fixtures/vercel-observability/good MUST pass clean (guards
//          false-positives).
//      Self-guard not holding ⇒ the check is broken ⇒ emit `unknown`, never pass.
//   3. Only with a fired negative control do we judge the real state document.
//      _common.mjs structurally downgrades a pass without a fired negative control.
//
// LIVE REALITY (documented trap): there are NO Vercel API credentials
// in-container. A live run (no --state-fixture) can NOT read the real project
// settings, so it returns status="unknown" — honestly unverified, NEVER a
// silent pass. `--state-fixture <file.json>` runs the SAME validator on an
// offline state document for deterministic verification.
//
// Run:  node vercel-observability.mjs                                  (live → unknown)
//       node vercel-observability.mjs --state-fixture f.json           (offline)
//       node vercel-observability.mjs --self-test                      (JSON, exit 0/2)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Result, emitResult } from "./_common.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const MANIFEST = join(PKG, "manifests", "vercel-observability.json");
const FIX_GOOD = join(PKG, "fixtures", "vercel-observability", "good", "state.json");
const FIX_BAD = join(PKG, "fixtures", "vercel-observability", "bad", "state.json");

const CONTROL = "vercel-observability";
const SURFACE = "infra";

function loadManifest() {
  return JSON.parse(readFileSync(MANIFEST, "utf8"));
}

function requiredKeys(m) {
  return Object.keys(m.state_document);
}

// ── Validator (the SAME logic runs on fixture and live data) ─────────────────
// A state document is an object of boolean settings. The control is ENABLED iff
// every required key is present and === true.
//   - any required key === false  → "fail" (name which), the control is disabled
//   - any required key missing, or the document is not a readable object
//                                 → "unknown" (cannot determine; not a finding)
//   - all required keys === true  → "pass"
function judge(doc, keys) {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    return { status: "unknown", disabled: [], missing: keys.slice(),
      detail: { reason: "state document is not a JSON object" } };
  }
  const disabled = [];
  const missing = [];
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(doc, k)) { missing.push(k); continue; }
    if (doc[k] !== true) disabled.push(k);
  }
  let status;
  if (missing.length) status = "unknown";
  else if (disabled.length) status = "fail";
  else status = "pass";
  return { status, disabled, missing, detail: { keys, doc } };
}

function summarize(keys, res) {
  return keys.map((k) => {
    if (res.missing.includes(k)) return `${k}=missing`;
    if (res.disabled.includes(k)) return `${k}=false`;
    return `${k}=true`;
  }).join(", ");
}

// ── Self-guard ───────────────────────────────────────────────────────────────
// Runs the EXACT judge() path used on real state, against the bundled good/bad
// fixtures. bad must be flagged fail (negative control fires; a required key is
// genuinely false); good must pass clean.
function selfGuard(keys) {
  let goodDoc, badDoc;
  try {
    goodDoc = JSON.parse(readFileSync(FIX_GOOD, "utf8"));
    badDoc = JSON.parse(readFileSync(FIX_BAD, "utf8"));
  } catch (e) {
    return { ok: false, injected: false, fired: false, note: `fixtures unreadable: ${e.message}` };
  }

  const good = judge(goodDoc, keys);
  const bad = judge(badDoc, keys);

  // injected: the bad fixture genuinely carries the violation — at least one
  // required key is present and === false (a disabled control), not merely
  // missing/empty. Prove the bad input is really present.
  const injected = keys.some(
    (k) => Object.prototype.hasOwnProperty.call(badDoc, k) && badDoc[k] === false);
  const fired = bad.status === "fail"; // our validator condemned the bad fixture
  const clean = good.status === "pass"; // good fixture earns a clean pass

  if (!injected) {
    return { ok: false, injected, fired,
      note: `self-guard FAILED: bad fixture carries no required key === false ` +
            `(${summarize(keys, bad)}) — the disabled-control negative control ` +
            `could not be injected` };
  }
  if (!fired) {
    return { ok: false, injected, fired,
      note: `self-guard FAILED: bad fixture judged ${bad.status} ` +
            `(${summarize(keys, bad)}) — negative control did not fire` };
  }
  if (!clean) {
    return { ok: false, injected, fired,
      note: `self-guard FAILED: good fixture judged ${good.status} ` +
            `(${summarize(keys, good)}) — false-positive, cannot trust the check` };
  }
  return { ok: true, injected, fired,
    note: `self-guard OK: bad fixture flagged fail (${summarize(keys, bad)}; ` +
          `disabled=${bad.disabled.join("/")}), good fixture clean pass ` +
          `(${summarize(keys, good)})` };
}

// ── Run against the real state document ──────────────────────────────────────
function run(doc, keys, mode) {
  const r = new Result(CONTROL, SURFACE);

  const sg = selfGuard(keys);
  r.negativeControl({ injected: sg.injected, fired: sg.fired, note: sg.note });
  if (!sg.ok) {
    return r.set("unknown", { evidence: sg.note,
      message: "vercel-observability check self-guard failed — verdict not trustworthy" });
  }

  const res = judge(doc, keys);
  const summary = summarize(keys, res);

  if (res.status === "unknown") {
    return r.set("unknown", {
      evidence: `${mode} judge: ${summary}. Missing keys: ` +
                `${res.missing.join(", ") || "none"}. ${JSON.stringify(res.detail)}`,
      message: `vercel-observability: state document incomplete/unreadable (unverifiable)` });
  }
  if (res.status === "fail") {
    return r.set("fail", {
      evidence: `${mode} judge: ${summary}. Disabled: ${res.disabled.join(", ")}. ` +
                `${JSON.stringify(res.detail)}`,
      message: `vercel-observability: disabled (${res.disabled.join(", ")})` });
  }
  return r.set("pass", {
    evidence: `${mode} judge: ${summary}; Vercel observability + firewall both enabled. ` +
              `${sg.note}`,
    message: `vercel-observability: project observability and firewall enabled` });
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function main(argv) {
  const keys = requiredKeys(loadManifest());

  if (argv.includes("--self-test")) {
    const sg = selfGuard(keys);
    console.log(JSON.stringify({ control: CONTROL, ok: sg.ok,
      injected: sg.injected, fired: sg.fired, note: sg.note }));
    return sg.ok ? 0 : 2;
  }

  const fixturePath = flag(argv, "--state-fixture");

  if (fixturePath) {
    let doc;
    try { doc = JSON.parse(readFileSync(fixturePath, "utf8")); }
    catch (e) {
      const r = new Result(CONTROL, SURFACE);
      return emitResult(r.set("unknown", { evidence: `state fixture unreadable: ${e.message}`,
        message: "vercel-observability: could not load --state-fixture" }));
    }
    return emitResult(run(doc, keys, "fixture"));
  }

  // LIVE mode: no Vercel API creds in-container, so the live settings cannot be
  // read. Honestly unverified — unknown, never a silent pass.
  const r = new Result(CONTROL, SURFACE);
  const sg = selfGuard(keys);
  r.negativeControl({ injected: sg.injected, fired: sg.fired, note: sg.note });
  return emitResult(r.set("unknown", {
    evidence: `live mode: no live state document; supply --state-fixture or live ` +
              `credentials (the Vercel project settings are not readable ` +
              `in-container). self-guard: ${sg.note}`,
    message: "vercel-observability: no live state document (unverifiable in-container)" }));
}

process.exit(main(process.argv.slice(2)));
