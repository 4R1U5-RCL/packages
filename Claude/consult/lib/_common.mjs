// _common.mjs — the SINGLE implementation of the consult result/verdict contract.
//
// Every flow in this package emits its result through this module. There is
// exactly one definition of "what a result looks like", one definition of the
// honest-pass rule (orchestration self-guard), and one definition of the
// honest-corroboration rule (the chain verdict). (WORKING_METHOD §5: one name
// per role, no synonyms — applied to the result shape itself.)
//
// Two vocabularies, kept deliberately separate:
//
//   STATUS  — the ORCHESTRATION self-guard outcome. Did the chain run as
//             specified and did its self-guard fire? Exactly three values:
//               pass     chain ran as specified AND its negative control fired
//                        (escalation/scoring invariants proven on fixtures)
//               fail     an orchestration invariant is violated (e.g. escalation
//                        did NOT fire when it must) — a real finding
//               unknown  a tier could not be reached/parsed, or the self-guard
//                        could not be exercised. NEVER a silent pass.
//             Exit codes: pass=0, fail=1, unknown=2.
//
//   CONFIDENCE — a SEPARATE field describing INTER-MODEL AGREEMENT about the
//             content: HIGH | MEDIUM | LOW (or null when there is no answer to
//             rate). A HIGH means the models CONCURRED — it does NOT mean the
//             answer is true. Truth is non-deterministic; we do not self-guard
//             it. We self-guard the orchestration.
//
// THE HONEST-PASS RULE (orchestration), enforced STRUCTURALLY here so no flow
// can opt out of it (mirrors audit/checks/_common.mjs):
//
//   A flow may only emit status="pass" if its negative control was actually
//   INJECTED and actually FIRED — a recorded fixture provably carried the
//   trigger (≥3 risks / a model dissent) and the orchestration provably reacted
//   (escalated / scored LOW). A "pass" without a fired negative control is
//   DOWNGRADED to "unknown".
//
// THE HONEST-CORROBORATION RULE (verdict), enforced STRUCTURALLY in
// finalizeVerdict() below:
//
//   A "validated"/corroborated verdict — or a HIGH confidence — REQUIRES the
//   corroborating tiers to have ACTUALLY responded. A tier that was unreachable
//   or returned a malformed/empty body CANNOT be counted as corroboration. If
//   the base tier itself did not respond, the verdict is "unknown" — never a
//   single-model answer dressed up as cross-validated, never a fabricated
//   response. This is the direct analog of audit's false-pass rule.

import { fileURLToPath } from "node:url";

export const VALID_STATUS = ["pass", "fail", "unknown"];
export const VALID_FLOW = ["research", "validate"];
export const VALID_CONFIDENCE = ["HIGH", "MEDIUM", "LOW"];

// Exit codes let CI/scheduled callers branch without parsing JSON:
//   0 pass, 1 fail (finding), 2 unknown (could not verify — treat as not-green)
export const EXIT = { pass: 0, fail: 1, unknown: 2 };

// ── The honest-corroboration rule (the structural verdict backstop) ──────────
// Applied to the raw verdict the chain builds, BEFORE it is trusted. Even if the
// chain miscomputed, a corroboration/HIGH claim whose corroborating tiers did
// not actually respond is downgraded here. policy.minForHigh = how many
// corroborating tiers must have responded to sustain a HIGH.
export function finalizeVerdict(v, policy = {}) {
  const minForHigh = policy.minForHigh ?? 2;
  const out = { ...v };
  const tiers = v.tiers || [];
  const base = tiers.find((t) => t.role === "base");
  const baseResponded = Boolean(base && base.responded);
  // Corroborating tiers = everything that is meant to validate the base answer.
  // The optional fact-check tier is supporting, not corroboration, and an
  // un-invoked (consent-withheld) tier is not a failure to respond.
  const corroborators = tiers.filter(
    (t) => t.role !== "base" && t.role !== "factcheck" && !t.optionalSkipped);
  const corrobResponded = corroborators.filter((t) => t.responded).length;
  const notes = [];

  if (!baseResponded) {
    out.verdict = "unknown";
    out.confidence = null;
    out.corroborated = false;
    notes.push(
      "HONEST-CORROBORATION: base tier did not respond (proxy unreachable or " +
      "malformed/empty body) — there is no answer to cross-validate. verdict=unknown; " +
      "NEVER a fabricated answer.");
    out.downgrade_note = notes.join(" ");
    return out;
  }

  if (corrobResponded < 1) {
    // No corroborating tier actually responded. There is no cross-validation —
    // only a single-model answer. We set out to cross-validate and could not, so
    // the verdict is unknown; it is NEVER dressed up as corroborated.
    out.verdict = "unknown";
    out.confidence = null;
    out.corroborated = false;
    notes.push(
      "HONEST-CORROBORATION: no corroborating tier actually responded (unreachable or " +
      "malformed/empty body) — a single-model answer is NOT a cross-validated result. " +
      "verdict=unknown; NEVER dressed up as corroborated.");
    out.downgrade_note = notes.join(" ");
    return out;
  }

  if (out.confidence === "HIGH" && corrobResponded < minForHigh) {
    out.confidence = corrobResponded >= 1 ? "MEDIUM" : "LOW";
    out.corroborated = corrobResponded >= 1 ? out.corroborated : false;
    notes.push(
      `HONEST-CORROBORATION: HIGH requires >=${minForHigh} corroborating tier(s) to have ` +
      `responded; only ${corrobResponded} did — downgraded to ${out.confidence}.`);
  }

  if (notes.length) out.downgrade_note = notes.join(" ");
  return out;
}

// ── The orchestration result (mirrors audit/checks/_common.mjs Result) ───────
export class Result {
  constructor(flow) {
    if (!VALID_FLOW.includes(flow)) {
      throw new Error(`flow must be one of ${VALID_FLOW}, got ${flow}`);
    }
    this.flow = flow;
    this.status = "unknown";
    this.evidence = "";
    this.message = "";
    this._nc = { injected: false, fired: false, note: "" };
    // The chain verdict rides alongside the orchestration status, never merged
    // into it. confidence/corroborated/verdict describe CONTENT agreement.
    this._verdict = null;
  }

  // Record what the self-guard observed: was the bad input (≥3 risks / a model
  // dissent) injected, and did the orchestration fire (escalate / score LOW).
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

  // Attach the chain verdict (already passed through finalizeVerdict). The
  // CONTENT confidence is reported, never folded into the orchestration status.
  chain(verdict) {
    this._verdict = verdict;
    return this;
  }

  // THE structural honest-pass enforcement (orchestration).
  _guardedStatus() {
    if (this.status === "pass" && !(this._nc.injected && this._nc.fired)) {
      return {
        status: "unknown",
        note: `SELF-GUARD: status was 'pass' but the negative control did not ` +
              `fire (injected=${this._nc.injected}, fired=${this._nc.fired}) — ` +
              `cannot certify orchestration that was not watched to escalate/diverge ` +
              `on a recorded fixture. Downgraded to unknown.`,
      };
    }
    return { status: this.status, note: null };
  }

  toObject() {
    const { status, note } = this._guardedStatus();
    const v = this._verdict;
    const out = {
      flow: this.flow,
      status,
      // CONTENT fields — inter-model agreement, NOT correctness. null when no run.
      confidence: v ? v.confidence : null,
      corroborated: v ? Boolean(v.corroborated) : false,
      verdict: v ? v.verdict : null,
      escalated: v && typeof v.escalated === "boolean" ? v.escalated : null,
      tiers: v ? v.tiers.map((t) => ({
        role: t.role, model: t.model, via: t.via ?? null, responded: t.responded,
        stance: t.stance ?? null, optionalSkipped: Boolean(t.optionalSkipped),
        error: t.error ?? null,
      })) : [],
      positions: v ? (v.positions ?? []) : [],
      risk_count: v && typeof v.riskCount === "number" ? v.riskCount : null,
      evidence: this.evidence,
      message: this.message,
      negative_control: { ...this._nc },
    };
    if (v && v.downgrade_note) out.corroboration_note = v.downgrade_note;
    if (note) out.self_guard_note = note;
    return out;
  }
}

export function emitResult(result, stream = process.stdout) {
  const d = result.toObject();
  stream.write(JSON.stringify(d) + "\n");
  return EXIT[d.status];
}

// CLI parity with audit's _common: any caller (incl. a shell wrapper) can emit
// through the one contract. node _common.mjs emit --flow research --status pass ...
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
  for (const req of ["flow", "status"]) {
    if (!f[req]) { process.stderr.write(`missing --${req}\n`); return 64; }
  }
  const r = new Result(f.flow);
  r.negativeControl({ injected: truthy(f["nc-injected"]),
                      fired: truthy(f["nc-fired"]), note: f["nc-note"] ?? "" });
  r.set(f.status, { evidence: f.evidence ?? "", message: f.message ?? "" });
  return emitResult(r);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [, , sub, ...rest] = process.argv;
  if (sub !== "emit") {
    process.stderr.write("usage: _common.mjs emit --flow ... --status ...\n");
    process.exit(64);
  }
  process.exit(cliEmit(rest));
}
