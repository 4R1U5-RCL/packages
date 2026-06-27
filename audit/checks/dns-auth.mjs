#!/usr/bin/env node
// dns-auth.mjs — CONTROL: dns-auth   SURFACE: infra
//
// Asserts: the sending domain (Resend; tessera-project.dev) publishes well-formed
// email-authentication records — SPF, DKIM (under at least one configured
// selector) and DMARC. A domain missing any one can be spoofed for phishing
// (T1684.002 email spoofing → T1566 phishing). This is the highest-leverage
// "looks fine, isn't" infra gap: mail still sends, it just isn't authenticated.
//
// SHAPE — mirrors rls.mjs (the reference check):
//
//   1. Read the FIXED manifest (manifests/dns-auth.json): sending domain + the
//      set of DKIM selectors to try. The audited surface is not model
//      discretion (WORKING_METHOD §1).
//   2. SELF-GUARD FIRST (WORKING_METHOD §7/§8). Before judging any real domain,
//      run the EXACT validator against the bundled fixtures:
//        - fixtures/dns-auth/bad  MUST be flagged fail (negative control FIRES;
//          it genuinely lacks DMARC and has a malformed SPF),
//        - fixtures/dns-auth/good MUST pass clean (guards false-positives).
//      Self-guard not holding ⇒ the check is broken ⇒ emit `unknown`, never pass.
//   3. Only with a fired negative control do we judge the target domain.
//      _common.mjs structurally downgrades a pass without a fired negative control.
//
// DNS REALITY (documented trap): the container's resolver is NOT the public
// internet. A live `--domain` run may fail to resolve records that exist
// publicly. Resolution failure ⇒ status="unknown", NEVER a silent pass and never
// a `fail` — we cannot prove absence from inside a box with a different resolver.
// `--resolver-fixture <file.json>` runs the SAME parser/validator on offline data
// for deterministic verification.
//
// Run:  node dns-auth.mjs --domain tessera-project.dev          (live DNS)
//       node dns-auth.mjs --resolver-fixture f.json --domain d  (offline)
//       node dns-auth.mjs --self-test                           (JSON, exit 0/2)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveTxt } from "node:dns/promises";
import { Result, emitResult } from "./_common.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const MANIFEST = join(PKG, "manifests", "dns-auth.json");
const FIX_GOOD = join(PKG, "fixtures", "dns-auth", "good", "resolver.json");
const FIX_BAD = join(PKG, "fixtures", "dns-auth", "bad", "resolver.json");

const CONTROL = "dns-auth";
const SURFACE = "infra";

function loadManifest() {
  return JSON.parse(readFileSync(MANIFEST, "utf8"));
}

// ── Resolvers ───────────────────────────────────────────────────────────────
// Both return the SAME shape: { records: string[], error: string|null }.
//   records  one string per TXT record (multi-chunk records joined).
//   error    set ONLY when the name could not be resolved (live DNS failure /
//            container resolver mismatch). An empty records[] with error=null
//            means "definitively no such record" — a finding, not a doubt.

// Offline: name → array of TXT strings. Absent name = definitive absence.
function fixtureResolver(map) {
  return async (name) => {
    if (Object.prototype.hasOwnProperty.call(map, name)) {
      return { records: map[name] ?? [], error: null };
    }
    return { records: [], error: null };
  };
}

// Live: node:dns/promises. Any DNS error → error set (treated as unresolvable /
// unknown), because inside the container we cannot tell "no record" from
// "this resolver can't see it".
function liveResolver() {
  return async (name) => {
    try {
      const chunks = await resolveTxt(name); // string[][]
      return { records: chunks.map((parts) => parts.join("")), error: null };
    } catch (e) {
      return { records: [], error: e?.code || e?.message || "resolve-failed" };
    }
  };
}

// ── Validators (the SAME logic runs on fixture and live data) ────────────────
function isValidSpf(rec) {
  return /^v=spf1\b/i.test(rec.trim());
}
function isValidDkim(rec) {
  return /v=DKIM1\b/i.test(rec) && /\bp=([A-Za-z0-9+/=]+)/.test(rec);
}
function isValidDmarc(rec) {
  return /v=DMARC1\b/i.test(rec) && /\bp=\s*(none|quarantine|reject)\b/i.test(rec);
}

// State of one record-class: "valid" | "invalid" | "unresolvable".
function classify({ records, error }, predicate) {
  if (records.some(predicate)) return "valid";
  if (error) return "unresolvable"; // could not see it — not provably absent
  return "invalid"; // resolved, but no well-formed record (missing/malformed)
}

// DKIM across selectors: valid if ANY selector resolves to a valid record.
function classifyDkim(lookups) {
  if (lookups.some((l) => l.records.some(isValidDkim))) return "valid";
  // none valid: if every attempted selector was unresolvable, we cannot tell;
  // if at least one selector definitively resolved without a valid record, that
  // is a real "no DKIM under the configured selectors" finding.
  if (lookups.every((l) => l.error)) return "unresolvable";
  return "invalid";
}

// Judge a domain against a resolver. Returns the three classifications + detail.
async function judge(resolve, domain, selectors) {
  const spfL = await resolve(domain);
  const dmarcL = await resolve(`_dmarc.${domain}`);
  const dkimLs = [];
  for (const sel of selectors) dkimLs.push({ sel, ...(await resolve(`${sel}._domainkey.${domain}`)) });

  const spf = classify(spfL, isValidSpf);
  const dmarc = classify(dmarcL, isValidDmarc);
  const dkim = classifyDkim(dkimLs);

  const detail = {
    spf: { state: spf, records: spfL.records, error: spfL.error },
    dkim: { state: dkim, selectors: dkimLs.map((l) => ({ selector: l.sel, error: l.error, records: l.records })) },
    dmarc: { state: dmarc, records: dmarcL.records, error: dmarcL.error },
  };

  // Overall: any unresolvable ⇒ unknown (cannot certify, cannot condemn).
  // Else any invalid ⇒ fail (a real, provable finding).
  // Else ⇒ pass.
  const states = [spf, dkim, dmarc];
  let status;
  if (states.includes("unresolvable")) status = "unknown";
  else if (states.includes("invalid")) status = "fail";
  else status = "pass";
  return { status, detail };
}

function summarize(detail) {
  const parts = [];
  for (const k of ["spf", "dkim", "dmarc"]) parts.push(`${k.toUpperCase()}=${detail[k].state}`);
  return parts.join(", ");
}

// ── Self-guard ───────────────────────────────────────────────────────────────
// Runs the EXACT judge() path used on real targets, against the bundled good/bad
// fixtures. bad must be flagged fail (negative control fires); good must pass.
async function selfGuard(domain, selectors) {
  let goodMap, badMap;
  try {
    goodMap = JSON.parse(readFileSync(FIX_GOOD, "utf8"));
    badMap = JSON.parse(readFileSync(FIX_BAD, "utf8"));
  } catch (e) {
    return { ok: false, injected: false, fired: false, note: `fixtures unreadable: ${e.message}` };
  }

  const good = await judge(fixtureResolver(goodMap), domain, selectors);
  const bad = await judge(fixtureResolver(badMap), domain, selectors);

  // injected: the bad fixture genuinely carries the violation — DMARC is absent
  // (no _dmarc record at all). Prove the bad input is really present, not an
  // empty/unmatched scan.
  const dmarcAbsent =
    bad.detail.dmarc.state === "invalid" && bad.detail.dmarc.records.length === 0;
  const injected = dmarcAbsent;
  const fired = bad.status === "fail"; // our validator condemned the bad fixture
  const clean = good.status === "pass"; // good fixture earns a clean pass

  if (!injected) {
    return { ok: false, injected, fired,
      note: `self-guard FAILED: bad fixture DMARC state=${bad.detail.dmarc.state}, ` +
            `records=${JSON.stringify(bad.detail.dmarc.records)} — the missing-DMARC ` +
            `negative control could not be injected` };
  }
  if (!fired) {
    return { ok: false, injected, fired,
      note: `self-guard FAILED: bad fixture judged ${bad.status} (${summarize(bad.detail)}) — ` +
            `negative control did not fire` };
  }
  if (!clean) {
    return { ok: false, injected, fired,
      note: `self-guard FAILED: good fixture judged ${good.status} (${summarize(good.detail)}) — ` +
            `false-positive, cannot trust the check` };
  }
  return { ok: true, injected, fired,
    note: `self-guard OK: bad fixture flagged fail (${summarize(bad.detail)}; DMARC absent), ` +
          `good fixture clean pass (${summarize(good.detail)})` };
}

// ── Run against the real target ──────────────────────────────────────────────
async function run(domain, resolve, mode) {
  const m = loadManifest();
  const selectors = m.dkim_selectors;
  const r = new Result(CONTROL, SURFACE);

  const sg = await selfGuard(m.sending_domain, selectors);
  r.negativeControl({ injected: sg.injected, fired: sg.fired, note: sg.note });
  if (!sg.ok) {
    return r.set("unknown", { evidence: sg.note,
      message: "dns-auth check self-guard failed — verdict not trustworthy" });
  }

  const { status, detail } = await judge(resolve, domain, selectors);
  const summary = summarize(detail);

  if (status === "unknown") {
    const errs = [];
    if (detail.spf.error) errs.push(`SPF:${detail.spf.error}`);
    for (const s of detail.dkim.selectors) if (s.error) errs.push(`DKIM[${s.selector}]:${s.error}`);
    if (detail.dmarc.error) errs.push(`DMARC:${detail.dmarc.error}`);
    return r.set("unknown", {
      evidence: `${mode} judge of ${domain}: ${summary}; could not resolve ` +
                `(${errs.join(", ") || "no resolver error detail"}). The container's ` +
                `resolver differs from the public internet — resolution failure is ` +
                `unknown, NOT a finding.`,
      message: `dns-auth: ${domain} records unresolvable in-container (unverifiable)` });
  }
  if (status === "fail") {
    const missing = [];
    if (detail.spf.state !== "valid") missing.push("SPF");
    if (detail.dkim.state !== "valid") missing.push(`DKIM(selectors=${selectors.join("/")})`);
    if (detail.dmarc.state !== "valid") missing.push("DMARC");
    return r.set("fail", {
      evidence: `${mode} judge of ${domain}: ${summary}. Missing/malformed: ` +
                `${missing.join(", ")}. ${JSON.stringify(detail)}`,
      message: `dns-auth: ${domain} fails email authentication (${missing.join(", ")})` });
  }
  return r.set("pass", {
    evidence: `${mode} judge of ${domain}: ${summary}; SPF + DKIM (selector found) + ` +
              `DMARC all well-formed. ${sg.note}`,
    message: `dns-auth: ${domain} publishes well-formed SPF, DKIM and DMARC` });
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv) {
  if (argv.includes("--self-test")) {
    const m = loadManifest();
    const sg = await selfGuard(m.sending_domain, m.dkim_selectors);
    console.log(JSON.stringify({ control: CONTROL, ok: sg.ok,
      injected: sg.injected, fired: sg.fired, note: sg.note }));
    return sg.ok ? 0 : 2;
  }

  const fixturePath = flag(argv, "--resolver-fixture");
  const domain = flag(argv, "--domain") || loadManifest().sending_domain;

  let resolve, mode;
  if (fixturePath) {
    let map;
    try { map = JSON.parse(readFileSync(fixturePath, "utf8")); }
    catch (e) {
      const r = new Result(CONTROL, SURFACE);
      return emitResult(r.set("unknown", { evidence: `resolver fixture unreadable: ${e.message}`,
        message: "dns-auth: could not load --resolver-fixture" }));
    }
    resolve = fixtureResolver(map);
    mode = "fixture";
  } else {
    resolve = liveResolver();
    mode = "live";
  }

  return emitResult(await run(domain, resolve, mode));
}

main(process.argv.slice(2)).then((code) => process.exit(code));
