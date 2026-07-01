#!/usr/bin/env node
// supabase-logging.mjs — CONTROL: supabase-logging   SURFACE: infra
//
// Asserts: the Supabase project has its audit/observability logging controls
// ENABLED — auth event logs, API (PostgREST/edge) logs, and an external log
// drain so logs leave the project and survive. Disabled logging is a silent
// detection gap: an attacker's auth abuse / data access leaves no trail to
// review (T1562.008 disable cloud logs → blinds T1078 valid-accounts abuse).
//
// SHAPE — mirrors dns-auth.mjs (the reference CONFIG/STATE check):
//
//   1. The control is verified by reading a STATE DOCUMENT — a small JSON of the
//      live logging settings, exactly what a Supabase management-API response
//      would carry. Offline/deterministic via `--state-fixture <file.json>`.
//   2. SELF-GUARD FIRST. Before judging any real state document, run the EXACT
//      validator against the bundled fixtures:
//        - fixtures/supabase-logging/bad  MUST be flagged fail (negative control
//          FIRES; it genuinely carries auth_logs_enabled=false),
//        - fixtures/supabase-logging/good MUST pass clean (guards false-positives).
//      Self-guard not holding ⇒ the check is broken ⇒ emit `unknown`, never pass.
//   3. Only with a fired negative control do we judge the target document.
//      _common.mjs structurally downgrades a pass without a fired negative control.
//
// LIVE REALITY (documented trap): we have NO Supabase management-API credentials
// in-container, so a live run cannot fetch the real settings document. Live mode
// (no `--state-fixture`) therefore returns status="unknown" — honestly
// unverified, NEVER a silent pass. Supply `--state-fixture` for deterministic
// offline verification; the SAME validator runs on fixture and (would-be) live.
//
// Run:  node supabase-logging.mjs --state-fixture f.json   (offline)
//       node supabase-logging.mjs                          (live → unknown)
//       node supabase-logging.mjs --self-test              (JSON, exit 0/2)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Result, emitResult } from "./_common.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const MANIFEST = join(PKG, "manifests", "supabase-logging.json");
const FIX_GOOD = join(PKG, "fixtures", "supabase-logging", "good", "state.json");
const FIX_BAD = join(PKG, "fixtures", "supabase-logging", "bad", "state.json");

const CONTROL = "supabase-logging";
const SURFACE = "infra";

// The required boolean keys: ALL must be true for the control to be enabled.
const REQUIRED_KEYS = ["auth_logs_enabled", "api_logs_enabled", "log_drain_configured"];

function loadManifest() {
  return JSON.parse(readFileSync(MANIFEST, "utf8"));
}

// ── Validator (the SAME logic runs on fixture and live data) ──────────────────
// Reads the required boolean keys from the state document.
//   - any key missing / document not an object → "unreadable" (cannot judge)
//   - all present-and-true → "enabled"
//   - any present-and-false → "disabled" (a real, provable finding)
// Returns { state, disabled:[], missing:[] }.
function validate(doc) {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    return { state: "unreadable", disabled: [], missing: REQUIRED_KEYS.slice() };
  }
  const missing = [];
  const disabled = [];
  for (const k of REQUIRED_KEYS) {
    if (typeof doc[k] !== "boolean") missing.push(k);
    else if (doc[k] === false) disabled.push(k);
  }
  if (missing.length) return { state: "unreadable", disabled, missing };
  if (disabled.length) return { state: "disabled", disabled, missing };
  return { state: "enabled", disabled, missing };
}

function summarize(v) {
  if (v.state === "unreadable") {
    return `state=unreadable (missing/non-boolean keys: ${v.missing.join("/") || "?"})`;
  }
  if (v.state === "disabled") return `state=disabled (false: ${v.disabled.join("/")})`;
  return `state=enabled (all of ${REQUIRED_KEYS.join("/")} true)`;
}

// ── Self-guard ────────────────────────────────────────────────────────────────
// Runs the EXACT validator used on real targets against the bundled good/bad
// fixtures. bad must be flagged disabled (negative control fires); good clean.
function selfGuard() {
  let goodDoc, badDoc;
  try {
    goodDoc = JSON.parse(readFileSync(FIX_GOOD, "utf8"));
    badDoc = JSON.parse(readFileSync(FIX_BAD, "utf8"));
  } catch (e) {
    return { ok: false, injected: false, fired: false, note: `fixtures unreadable: ${e.message}` };
  }

  const good = validate(goodDoc);
  const bad = validate(badDoc);

  // injected: the bad fixture genuinely carries a disabled control — at least one
  // required key is present and === false. Prove the bad input is really present.
  const injected = bad.disabled.length > 0;
  const fired = bad.state === "disabled"; // validator condemned the bad fixture
  const clean = good.state === "enabled"; // good fixture earns a clean pass

  if (!injected) {
    return { ok: false, injected, fired,
      note: `self-guard FAILED: bad fixture carries no disabled required key ` +
            `(${summarize(bad)}) — the negative control could not be injected` };
  }
  if (!fired) {
    return { ok: false, injected, fired,
      note: `self-guard FAILED: bad fixture validated ${bad.state} (${summarize(bad)}) — ` +
            `negative control did not fire` };
  }
  if (!clean) {
    return { ok: false, injected, fired,
      note: `self-guard FAILED: good fixture validated ${good.state} (${summarize(good)}) — ` +
            `false-positive, cannot trust the check` };
  }
  return { ok: true, injected, fired,
    note: `self-guard OK: bad fixture flagged fail (${summarize(bad)}), ` +
          `good fixture clean pass (${summarize(good)})` };
}

// ── Run against the real target ───────────────────────────────────────────────
function run(doc, mode, source) {
  const r = new Result(CONTROL, SURFACE);

  const sg = selfGuard();
  r.negativeControl({ injected: sg.injected, fired: sg.fired, note: sg.note });
  if (!sg.ok) {
    return r.set("unknown", { evidence: sg.note,
      message: "supabase-logging check self-guard failed — verdict not trustworthy" });
  }

  // Live mode: no state document available (no management-API creds in-container).
  if (doc === undefined) {
    return r.set("unknown", {
      evidence: "no live state document; supply --state-fixture or live credentials. " +
                "Supabase logging settings come from the management API, for which we " +
                "have no in-container credentials — live state is honestly unverified, " +
                "NOT a finding and NOT a silent pass.",
      message: "supabase-logging: no live state document (unverifiable in-container)" });
  }

  const v = validate(doc);
  const summary = summarize(v);

  if (v.state === "unreadable") {
    return r.set("unknown", {
      evidence: `${mode} validate of ${source}: ${summary}. Required keys ` +
                `${REQUIRED_KEYS.join("/")} must each be a boolean — a missing or ` +
                `non-boolean key means we cannot judge the control (unknown, NOT a finding).`,
      message: "supabase-logging: state document unreadable (unverifiable)" });
  }
  if (v.state === "disabled") {
    return r.set("fail", {
      evidence: `${mode} validate of ${source}: ${summary}. Logging controls disabled: ` +
                `${v.disabled.join(", ")}. ${JSON.stringify(doc)}`,
      message: `supabase-logging: logging disabled (${v.disabled.join(", ")})` });
  }
  return r.set("pass", {
    evidence: `${mode} validate of ${source}: ${summary}; all logging controls enabled. ${sg.note}`,
    message: "supabase-logging: auth logs, API logs and log drain all enabled" });
}

// ── CLI ───────────────────────────────────────────────────────────────────────
function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function main(argv) {
  if (argv.includes("--self-test")) {
    const sg = selfGuard();
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
        message: "supabase-logging: could not load --state-fixture" }));
    }
    return emitResult(run(doc, "fixture", fixturePath));
  }

  // Live mode: no fixture, no management-API creds → unknown (never a silent pass).
  return emitResult(run(undefined, "live", "management-API"));
}

process.exit(main(process.argv.slice(2)));
