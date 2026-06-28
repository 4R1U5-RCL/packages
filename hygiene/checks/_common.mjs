// _common.mjs — the SINGLE implementation of the control output contract.
//
// Every control in this package (cleanup, backup) emits its result through this
// module. There is exactly one definition of "what a result looks like" and one
// definition of the honest-pass rule. (WORKING_METHOD §5: one name per role, no
// synonyms — applied to the result shape itself.)
//
// THE HONEST-PASS RULE (WORKING_METHOD §7/§8), enforced STRUCTURALLY here so no
// individual control can opt out of it:
//
//   A control may only emit status="pass" if its negative control was actually
//   INJECTED and actually FIRED — the known-bad input was provably present and
//   the control provably caught it. For cleanup that bad input is a stray file
//   the detector must flag; for backup it is an archive that MISSES a known file,
//   which the verifier must catch. A "pass" without a fired negative control is
//   DOWNGRADED to "unknown". A pass that wasn't watched to fail is not a pass.
//
// Status vocabulary (the only three):
//   pass     the action/scan held AND the negative control fired (earned green)
//   fail     a real finding — drift detected, or an archive that did not verify
//   unknown  could not determine — target unreadable, the bad input could not be
//            injected, tar/sha tooling failed. NEVER a silent pass.
//
// Surface vocabulary (the only one for this package):
//   local    operates on a local config tree on the host (default ~/.claude).
//            There is no "repo" or "infra" surface here — hygiene tends a home
//            tree, not a deployed stack. Naming it honestly keeps the contract
//            from implying coverage it does not have.

import { fileURLToPath } from "node:url";

export const VALID_STATUS = ["pass", "fail", "unknown"];
export const VALID_SURFACE = ["local"];

// Exit codes let CI/scheduled callers branch without parsing JSON:
//   0 pass, 1 fail (finding), 2 unknown (could not verify — treat as not-green)
export const EXIT = { pass: 0, fail: 1, unknown: 2 };

export class Result {
  constructor(control, surface, title = null) {
    if (!VALID_SURFACE.includes(surface)) {
      throw new Error(`surface must be one of ${VALID_SURFACE}, got ${surface}`);
    }
    this.control = control;
    this.surface = surface;
    this.title = title;
    this.status = "unknown";
    this.evidence = "";
    this.message = "";
    this.details = {};
    this._nc = { injected: false, fired: false, note: "" };
  }

  // Record what the self-guard observed: was the bad input injected, and did the
  // control fire (catch it).
  negativeControl({ injected, fired, note = "" }) {
    this._nc = { injected: Boolean(injected), fired: Boolean(fired), note };
    return this;
  }

  // Optional structured payload (stray list, archive sha256, etc.).
  detail(obj) {
    this.details = { ...this.details, ...obj };
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
    const out = {
      control: this.control,
      title: this.title,
      surface: this.surface,
      status,
      evidence: this.evidence,
      message: this.message,
      negative_control: { ...this._nc },
      details: this.details,
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
  const r = new Result(f.control, f.surface, f.title ?? null);
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
