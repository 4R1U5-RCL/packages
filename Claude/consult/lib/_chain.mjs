// _chain.mjs — THE single home of the cross-model chain logic.
//
// Tier sequencing, escalation policy, confidence/risk scoring from inter-model
// agreement, and response parsing all live HERE, exactly once. The two flows
// (flows/research.mjs, flows/validate.mjs) are thin callers; CI and scheduled
// are thin wrappers over run.mjs. One logic-unit, one home.
//
// CRITICAL DESIGN: the chain takes an INJECTABLE `callModel(model, prompt)`. The
// SAME orchestration code is exercised in self-test (fed RECORDED fixtures via
// makeFixtureCallModel) and in production (fed lib/_proxy.mjs). There is no
// parallel test path — the negative control proves the exact code that runs
// against a live proxy. (This is precisely how audit's self-guard runs
// findViolations() on fixtures.)
//
// NO HTTP in this file. NO secrets. NO logging of prompts or keys.
//
// Determinism note: models return free text, but the chain instructs each model
// (see prompt builders) to end its reply with structured markers it then parses:
//   STANCE: concur | dissent     (does this tier agree with the base answer?)
//   RISK: <one risk per line>     (validate: substantive risks the validator found)
//   UNCERTAIN: true               (the validator is unsure)
//   POSITION: <one-line stance>   (surfaced when models diverge)
// Parsing these markers is what makes scoring deterministic in BOTH modes.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { finalizeVerdict } from "./_common.mjs";

// ── Response parsing ─────────────────────────────────────────────────────────
// Accepts whatever callModel returns. In production that is the parsed JSON body
// from the LiteLLM proxy (OpenAI chat-completions shape). A null, an explicit
// {__unreachable} sentinel, or any body without a non-empty
// choices[0].message.content is "did not respond" — NEVER fabricated into text.
export function parseModelResponse(raw) {
  if (raw == null) return { responded: false, text: "", error: "no response object (proxy unreachable)" };
  if (raw.__unreachable) return { responded: false, text: "", error: raw.error || "proxy unreachable" };
  let content;
  try { content = raw?.choices?.[0]?.message?.content; } catch { content = undefined; }
  if (typeof content !== "string" || content.trim() === "") {
    return { responded: false, text: "",
             error: "malformed or empty proxy body (no choices[0].message.content)" };
  }
  return { responded: true, text: content, error: null };
}

export function parseStance(text) {
  const m = /^\s*STANCE:\s*(concur|dissent)\b/im.exec(text || "");
  return m ? m[1].toLowerCase() : null;
}
export function parseUncertain(text) {
  return /^\s*UNCERTAIN:\s*(true|yes)\b/im.test(text || "");
}
export function parseRisks(text) {
  return [...(text || "").matchAll(/^\s*RISK:\s*(.+?)\s*$/gim)].map((m) => m[1]);
}
export function parsePosition(text) {
  const m = /^\s*POSITION:\s*(.+?)\s*$/im.exec(text || "");
  if (m) return m[1];
  const first = (text || "").trim().split("\n")[0] || "";
  return first.slice(0, 200);
}

// ── Tier helpers ─────────────────────────────────────────────────────────────
export function tiersOf(manifest) {
  const t = [...manifest.tiers];
  if (manifest.factcheck) t.push(manifest.factcheck);
  return t;
}
function byRole(manifest, role) {
  return manifest.tiers.find((t) => t.role === role) || (manifest.factcheck?.role === role ? manifest.factcheck : null);
}

async function callTier(callModel, tier, prompt) {
  let raw;
  try { raw = await callModel(tier.model, prompt); }
  catch (e) { raw = { __unreachable: true, error: e?.message || "callModel threw" }; }
  const p = parseModelResponse(raw);
  return {
    role: tier.role, model: tier.model, purpose: tier.purpose,
    via: tier.via ?? "proxy",
    responded: p.responded, text: p.text, error: p.error,
    stance: p.responded ? parseStance(p.text) : null,
  };
}

// The base answer is supplied by the CALLING AGENT — Claude IS the base tier, as
// in the original /research and /validate skills. It is recorded as a responded
// tier WITHOUT any proxy call (the proxy has no Claude model and serves only the
// corroborators). Nothing is fabricated: the position is exactly the text the
// caller passed in. When no base answer is supplied, callers fall back to
// callTier against the base model, which — being unreachable — yields unknown.
function agentBaseTier(tier, answer) {
  return {
    role: tier.role, model: tier.model, purpose: tier.purpose,
    via: tier.via ?? "agent",
    responded: true, text: String(answer), error: null,
    stance: "concur",
  };
}
function hasBaseAnswer(baseAnswer) {
  return baseAnswer != null && String(baseAnswer).trim() !== "";
}

// ── Prompt builders (live only; markers requested so parsing is deterministic) ─
function basePromptResearch(q) {
  return `Answer this question precisely and cite sources where possible.\n\nQUESTION: ${q}\n\n` +
         `End your reply with: STANCE: concur (you stand by this answer).`;
}
function validatorPromptResearch(q, baseText) {
  return `A base model answered the question below. Independently validate it. If you ` +
         `agree, end with "STANCE: concur"; if you disagree, end with "STANCE: dissent" ` +
         `and a "POSITION: <your differing answer>" line.\n\nQUESTION: ${q}\n\nBASE ANSWER:\n${baseText}`;
}
function revalidatorPromptResearch(q, baseText, valText) {
  return `Two models have weighed in on the question below. Re-validate independently. ` +
         `End with "STANCE: concur" or "STANCE: dissent" + a "POSITION:" line.\n\n` +
         `QUESTION: ${q}\n\nBASE:\n${baseText}\n\nVALIDATOR:\n${valText}`;
}
function basePromptValidate(plan) {
  return `Summarise the plan/proposal below neutrally in 2-3 sentences, then list its ` +
         `STRENGTH: lines.\n\nPLAN:\n${plan}\n\nEnd with STANCE: concur.`;
}
function validatorPromptValidate(plan) {
  return `Critically review the plan/proposal below. List each substantive risk on its ` +
         `own "RISK: <risk>" line. If you are not confident in your review, add ` +
         `"UNCERTAIN: true". End with "STANCE: concur" (plan is sound) or "STANCE: dissent".` +
         `\n\nPLAN:\n${plan}`;
}
function revalidatorPromptValidate(plan, riskText) {
  return `A reviewer raised the risks below on this plan. Independently re-assess them and ` +
         `surface any they missed (one "RISK:" line each), plus "ALT: <alternative>" lines. ` +
         `End with "STANCE: concur" or "STANCE: dissent".\n\nPLAN:\n${plan}\n\nRAISED RISKS:\n${riskText}`;
}

// ── research flow ─────────────────────────────────────────────────────────────
// base answer -> validator -> revalidator (+ optional consented fact-check),
// then assign a confidence label from inter-model agreement.
export async function runResearch({ question, manifest, callModel, baseAnswer = null, factcheck = false }) {
  const minForHigh = manifest.confidence?.min_corroborating_responders_for_high ?? 2;

  const baseTier = byRole(manifest, "base");
  // Base is agent-supplied (no proxy call) when provided; otherwise fall back to
  // proxy-calling the base model (unreachable for Claude => unknown downstream).
  const base = hasBaseAnswer(baseAnswer)
    ? agentBaseTier(baseTier, baseAnswer)
    : await callTier(callModel, baseTier, basePromptResearch(question));
  const validator = await callTier(callModel, byRole(manifest, "validator"),
    validatorPromptResearch(question, base.text));
  const revalidator = await callTier(callModel, byRole(manifest, "revalidator"),
    revalidatorPromptResearch(question, base.text, validator.text));

  const tiers = [base, validator, revalidator];

  // Optional Perplexity fact-check — only when explicitly consented (the SKILL
  // asks the user first). Otherwise it is recorded as skipped, not failed.
  if (manifest.factcheck) {
    if (factcheck) {
      const fc = await callTier(callModel, manifest.factcheck,
        `Fact-check the key claims in this answer against current web sources. ` +
        `End with STANCE: concur or STANCE: dissent.\n\n${base.text}`);
      tiers.push(fc);
    } else {
      tiers.push({ role: manifest.factcheck.role, model: manifest.factcheck.model,
        via: manifest.factcheck.via ?? "proxy",
        responded: false, optionalSkipped: true, stance: null,
        error: "fact-check not invoked (consent not given)" });
    }
  }

  // Score from agreement among the corroborating tiers that actually responded.
  const corroborators = [validator, revalidator];
  const responded = corroborators.filter((c) => c.responded);
  const dissent = responded.filter((c) => c.stance === "dissent");
  const concur = responded.filter((c) => c.stance === "concur");

  let confidence, corroborated, verdict;
  const positions = [{ tier: "base", model: base.model,
    position: base.responded ? parsePosition(base.text) : "(no answer)" }];

  if (!base.responded) {
    confidence = null; corroborated = false; verdict = "unknown";
  } else if (responded.length === 0) {
    // No corroborating tier responded — the cross-validation never happened.
    // finalizeVerdict turns this into verdict=unknown; do not present a base-only
    // answer as a research result.
    confidence = null; corroborated = false; verdict = "unknown";
  } else if (dissent.length > 0) {
    // Models diverge → LOW, and BOTH positions are surfaced (never silently
    // collapsed to the base answer).
    confidence = "LOW"; corroborated = false; verdict = "diverged";
    for (const d of dissent) positions.push({ tier: d.role, model: d.model, stance: "dissent",
      position: parsePosition(d.text) });
  } else if (concur.length >= minForHigh && concur.length === responded.length) {
    confidence = "HIGH"; corroborated = true; verdict = "validated";
  } else {
    confidence = "MEDIUM"; corroborated = true; verdict = "partial";
  }

  const raw = { flow: "research", question, tiers, confidence, corroborated, verdict, positions };
  return finalizeVerdict(raw, { minForHigh });
}

// ── validate flow ─────────────────────────────────────────────────────────────
// base summary -> validator finds risks -> ESCALATE to revalidator if the
// validator raises >= threshold substantive risks OR expresses uncertainty.
export async function runValidate({ plan, manifest, callModel, baseAnswer = null, factcheck = false }) {
  const threshold = manifest.escalation?.risk_threshold ?? 3;
  const escalateOnUncertainty = manifest.escalation?.escalate_on_uncertainty ?? true;
  const minForHigh = manifest.confidence?.min_corroborating_responders_for_high ?? 1;

  const baseTier = byRole(manifest, "base");
  // Base summary is agent-supplied (no proxy call) when provided; otherwise fall
  // back to proxy-calling the base model (unreachable for Claude => unknown).
  const base = hasBaseAnswer(baseAnswer)
    ? agentBaseTier(baseTier, baseAnswer)
    : await callTier(callModel, baseTier, basePromptValidate(plan));
  const validator = await callTier(callModel, byRole(manifest, "validator"), validatorPromptValidate(plan));

  const risks = validator.responded ? parseRisks(validator.text) : [];
  const uncertain = validator.responded ? parseUncertain(validator.text) : false;
  const riskCount = risks.length;

  // THE escalation invariant: >= threshold substantive risks (or uncertainty)
  // MUST escalate to the revalidator; fewer must NOT.
  const escalate = validator.responded &&
    (riskCount >= threshold || (escalateOnUncertainty && uncertain));

  const tiers = [base, validator];
  let revalidator = null;
  if (escalate) {
    revalidator = await callTier(callModel, byRole(manifest, "revalidator"),
      revalidatorPromptValidate(plan, risks.map((r) => `RISK: ${r}`).join("\n")));
    tiers.push(revalidator);
  } else {
    const rev = byRole(manifest, "revalidator");
    tiers.push({ role: rev.role, model: rev.model, via: rev.via ?? "proxy",
      responded: false, optionalSkipped: true, stance: null,
      error: `not escalated (risks=${riskCount} < threshold=${threshold}, uncertain=${uncertain})` });
  }

  if (manifest.factcheck) {
    if (factcheck) {
      const fc = await callTier(callModel, manifest.factcheck,
        `Verify any external/empirical claims in these risks against current web sources. ` +
        `End with STANCE: concur or STANCE: dissent.\n\n${risks.join("\n")}`);
      tiers.push(fc);
    } else {
      tiers.push({ role: manifest.factcheck.role, model: manifest.factcheck.model,
        via: manifest.factcheck.via ?? "proxy",
        responded: false, optionalSkipped: true, stance: null,
        error: "fact-check not invoked (consent not given)" });
    }
  }

  let confidence, corroborated, verdict;
  if (!base.responded || !validator.responded) {
    confidence = null; corroborated = false; verdict = "unknown";
  } else if (escalate) {
    // A risky plan that escalated: confidence reflects whether the revalidator
    // corroborated the risk picture. (finalizeVerdict downgrades if it didn't
    // actually respond.)
    if (revalidator && revalidator.responded) {
      confidence = revalidator.stance === "dissent" ? "LOW" : "MEDIUM";
      corroborated = true; verdict = "escalated";
    } else {
      confidence = "MEDIUM"; corroborated = true; verdict = "escalated";
    }
  } else {
    // Clean: the validator found few risks and concurs the plan is sound.
    confidence = validator.stance === "dissent" ? "LOW" : "HIGH";
    corroborated = true; verdict = "clean";
  }

  const positions = [];
  if (validator.responded) {
    positions.push({ tier: "validator", model: validator.model, stance: validator.stance,
      risks });
  }
  if (revalidator && revalidator.responded) {
    positions.push({ tier: "revalidator", model: revalidator.model, stance: revalidator.stance,
      added_risks: parseRisks(revalidator.text) });
  }

  const raw = { flow: "validate", plan, tiers, confidence, corroborated, verdict,
    escalated: escalate, riskCount, uncertain, positions };
  return finalizeVerdict(raw, { minForHigh });
}

// ── Fixture-backed callModel (the swap-in for _proxy in self-test) ───────────
// Reads <scenarioDir>/<role>.json for each tier and returns the recorded body.
// A role file that is absent → returns null (the tier "did not respond"); a file
// that is not valid JSON → returns a malformed marker. This is the loader that
// stands in for lib/_proxy.mjs, exercising the REAL orchestration above.
export function makeFixtureCallModel(scenarioDir, manifest) {
  const byModel = new Map();
  for (const t of tiersOf(manifest)) {
    const f = join(scenarioDir, `${t.role}.json`);
    if (!existsSync(f)) continue;
    let obj;
    try { obj = JSON.parse(readFileSync(f, "utf8")); }
    catch { obj = { __malformed: true }; } // garbage body → parseModelResponse => not responded
    byModel.set(t.model, obj);
  }
  return async (model) => (byModel.has(model) ? byModel.get(model) : null);
}
