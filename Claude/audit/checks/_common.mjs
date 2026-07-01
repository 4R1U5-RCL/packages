// _common.mjs — the SINGLE implementation of the check output contract.
//
// Every check in this package emits its result through this module. There is
// exactly one definition of "what a result looks like" and one definition of
// the honest-pass rule. (WORKING_METHOD §5: one name per role, no synonyms —
// applied to the result shape itself.)
//
// THE HONEST-PASS RULE (WORKING_METHOD §7/§8), enforced STRUCTURALLY here so no
// individual check can opt out of it:
//
//   A check may only emit status="pass" if its negative control was actually
//   INJECTED and actually FIRED — the bad input was provably present and the
//   control provably caught/blocked it. A "pass" without a fired negative
//   control is DOWNGRADED to "unknown". A pass that wasn't watched to fail is
//   not a pass.
//
// Status vocabulary (the only three):
//   pass     control present AND negative control fired (earned green)
//   fail     control absent, OR bad input was NOT caught (a real finding)
//   unknown  could not determine — unreachable, parse miss, bad input could not
//            be injected, network error. NEVER a silent pass.
//
// Citations (WORKING_METHOD §1) live once in mapping/controls.json and are
// looked up here by control id — the mapping is the single source of truth; the
// check just names its control.
//
// CLI (so any caller, incl. a shell wrapper, can emit through the one contract):
//   node _common.mjs emit --control rls --surface repo --status pass \
//       --nc-injected true --nc-fired true --evidence "..." --message "..."

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
// mapping/ lives one level up from checks/. INTERNAL package path — never a
// reach OUT of ~/audit. Self-containment holds.
const MAPPING = join(HERE, "..", "mapping", "controls.json");

export const VALID_STATUS = ["pass", "fail", "unknown"];
// Surfaces are the coarse axis (where the control lives). `app` is the third —
// OWASP Top 10 against the delivered web application — alongside repo and infra.
export const VALID_SURFACE = ["repo", "infra", "app"];
// Reachability is the orthogonal finer axis the dispatcher keys on:
//   static  — verifiable against source/build (CI-runnable, invoked with --target)
//   dynamic — needs a live endpoint to probe (agent/scheduled, invoked via --config)
// null is allowed: existing repo/infra checks don't declare it and the dispatcher
// defaults them (repo→static, infra→dynamic), so the seven original checks are
// untouched. App checks declare it explicitly (app:static vs app:dynamic).
export const VALID_REACHABILITY = ["static", "dynamic"];

// Exit codes let CI/scheduled callers branch without parsing JSON:
//   0 pass, 1 fail (finding), 2 unknown (could not verify — treat as not-green)
export const EXIT = { pass: 0, fail: 1, unknown: 2 };

export function loadCitation(control) {
  let data;
  try {
    data = JSON.parse(readFileSync(MAPPING, "utf8"));
  } catch {
    return { attack: [], iso27001_2022: [], soc2_cc: [],
             _citation_status: "mapping-unreadable" };
  }
  const entry = data[control];
  if (!entry) {
    return { attack: [], iso27001_2022: [], soc2_cc: [],
             _citation_status: "control-not-in-mapping" };
  }
  return {
    attack: entry.attack ?? [],
    iso27001_2022: entry.iso27001_2022 ?? [],
    soc2_cc: entry.soc2_cc ?? [],
    title: entry.title,
    _citation_status: "ok",
  };
}

export class Result {
  // reachability is optional (null for the original repo/infra checks). When an
  // `app` check passes "static"/"dynamic" it is validated and carried through to
  // the emitted object so the dispatcher and report can see the sub-tag.
  constructor(control, surface, reachability = null) {
    if (!VALID_SURFACE.includes(surface)) {
      throw new Error(`surface must be one of ${VALID_SURFACE}, got ${surface}`);
    }
    if (reachability !== null && !VALID_REACHABILITY.includes(reachability)) {
      throw new Error(`reachability must be one of ${VALID_REACHABILITY} or null, got ${reachability}`);
    }
    this.control = control;
    this.surface = surface;
    this.reachability = reachability;
    this.status = "unknown";
    this.evidence = "";
    this.message = "";
    this._nc = { injected: false, fired: false, note: "" };
  }

  // Record what the self-guard observed: was the bad input injected, and did
  // the control fire (catch/block) it.
  negativeControl({ injected, fired, note = "" }) {
    this._nc = { injected: Boolean(injected), fired: Boolean(fired), note };
    return this;
  }

  set(status, { evidence = "", message = "" } = {}) {
    if (!VALID_STATUS.includes(status)) {
      throw new Error(`status must be one of ${VALID_STATUS}, got ${status}`);
    }
    this.status = status;
    if (evidence) this.evidence = evidence;
    if (message) this.message = message;
    return this;
  }

  // THE structural honest-pass enforcement.
  _guardedStatus() {
    if (this.status === "pass" && !(this._nc.injected && this._nc.fired)) {
      return {
        status: "unknown",
        note: `SELF-GUARD: status was 'pass' but the negative control did not ` +
              `fire (injected=${this._nc.injected}, fired=${this._nc.fired}) — ` +
              `cannot certify a pass that was not watched to fail ` +
              `(WORKING_METHOD §7). Downgraded to unknown.`,
      };
    }
    return { status: this.status, note: null };
  }

  toObject() {
    const { status, note } = this._guardedStatus();
    const cite = loadCitation(this.control);
    const out = {
      control: this.control,
      title: cite.title ?? null,
      surface: this.surface,
      reachability: this.reachability,
      status,
      evidence: this.evidence,
      message: this.message,
      negative_control: { ...this._nc },
      attack: cite.attack,
      iso27001_2022: cite.iso27001_2022,
      soc2_cc: cite.soc2_cc,
      citation_status: cite._citation_status,
    };
    if (note) out.self_guard_note = note;
    return out;
  }
}

export function emitResult(result, stream = process.stdout) {
  const d = result.toObject();
  stream.write(JSON.stringify(d) + "\n");
  return EXIT[d.status];
}

function truthy(v) {
  return ["1", "true", "yes", "y", "on"].includes(String(v).trim().toLowerCase());
}

function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const val = (i + 1 < argv.length && !argv[i + 1].startsWith("--")) ? argv[++i] : "true";
      out[key] = val;
    }
  }
  return out;
}

function cliEmit(argv) {
  const f = parseFlags(argv);
  for (const req of ["control", "surface", "status"]) {
    if (!f[req]) { process.stderr.write(`missing --${req}\n`); return 64; }
  }
  const r = new Result(f.control, f.surface, f.reachability ?? null);
  r.negativeControl({ injected: truthy(f["nc-injected"]),
                      fired: truthy(f["nc-fired"]), note: f["nc-note"] ?? "" });
  r.set(f.status, { evidence: f.evidence ?? "", message: f.message ?? "" });
  return emitResult(r);
}

// Run as CLI only when invoked directly.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [, , sub, ...rest] = process.argv;
  if (sub !== "emit") {
    process.stderr.write("usage: _common.mjs emit --control ... --surface ... --status ...\n");
    process.exit(64);
  }
  process.exit(cliEmit(rest));
}
