#!/usr/bin/env node
// alert-route.mjs — CONTROL: alert-route   SURFACE: infra
//
// Asserts: a TEST EVENT actually reaches the alert channel — closing the
// detection→response loop. A control that detects but cannot dispatch is half a
// control; this check proves the dispatch seam (notify/notify.mjs) really
// delivers.
//
// THE KEY DESIGN POINT (read notify/README.md): the alert channel is currently
// STUBBED, pending an n8n workflow. Against the REAL seam, send_alert() returns
// delivered:false / status:"not-wired". By construction that yields `unknown`
// (an honest *unverified* — channel not wired), NEVER a pass and NEVER a fail.
// It cannot flip to a pass until a real test event is watched to arrive at a
// real channel.
//
// SHAPE — mirrors dns-auth.mjs (the reference infra check):
//
//   1. SELF-GUARD FIRST (WORKING_METHOD §7/§8). Before reporting any live
//      verdict, run the EXACT judge() against two bundled mock notifiers:
//        - fixtures/alert-route/bad-notifier  delivered:false / status:"error"
//          MUST be judged fail (negative control FIRES — a wired channel that
//          did not deliver is a real finding),
//        - fixtures/alert-route/good-notifier delivered:true / status:"delivered"
//          MUST be judged pass (guards false-negatives).
//      Self-guard not holding ⇒ the check is broken ⇒ emit `unknown`, never pass.
//      NOTE: the stub's "not-wired" → unknown path is the LIVE behaviour, NOT
//      part of the pass/fail self-guard. Self-guard proves the check can tell
//      delivered (pass) from failed-delivery (fail).
//   2. Only with a fired negative control do we judge the live seam. Against the
//      stub that is `unknown` by construction. _common.mjs structurally
//      downgrades any pass without a fired negative control.
//
// Run:  node alert-route.mjs                                   (real stub → unknown)
//       node alert-route.mjs --notifier fixtures/.../good-notifier.mjs
//       node alert-route.mjs --self-test                       (JSON, exit 0/2)

import { fileURLToPath } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";
import { Result, emitResult } from "./_common.mjs";
import { makeEvent } from "../notify/notify.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const FIX_GOOD = join(PKG, "fixtures", "alert-route", "good-notifier.mjs");
const FIX_BAD = join(PKG, "fixtures", "alert-route", "bad-notifier.mjs");

const CONTROL = "alert-route";
const SURFACE = "infra";

// ── Judge (the SAME logic runs on fixture notifiers and the live seam) ────────
// Fire a synthetic test event through the supplied send_alert, then classify:
//   delivered === true        → pass  (event provably reached a channel)
//   status === "not-wired"    → unknown (channel stubbed / not wired — honest
//                               unverified; the live stub path)
//   otherwise (delivered:false, status !== "not-wired", e.g. "error")
//                             → fail  (a WIRED channel that did not deliver is a
//                               real finding)
async function judge(sendAlertFn) {
  const event = makeEvent({
    source: "audit",
    severity: "info",
    control: "alert-route",
    title: "audit alert-route test",
    detail: "synthetic test event",
    ts: null,
  });
  const res = await sendAlertFn(event);
  const delivered = res?.delivered === true;
  const notifierStatus = res?.status ?? null;
  const note = res?.note ?? "";
  const channel = res?.channel ?? null;

  let status, message;
  if (delivered) {
    status = "pass";
    message = `alert-route: test event delivered via channel "${channel}"`;
  } else if (notifierStatus === "not-wired") {
    status = "unknown";
    message = "alert route NOT verified — channel stubbed, n8n workflow pending";
  } else {
    status = "fail";
    message = `alert-route: wired channel did NOT deliver (status="${notifierStatus}")`;
  }

  const evidence =
    `judge fired test event through send_alert → delivered=${delivered}, ` +
    `status=${JSON.stringify(notifierStatus)}, channel=${JSON.stringify(channel)}. ` +
    `note: ${note}`;

  return { status, delivered, notifierStatus, evidence, message };
}

// ── Self-guard ───────────────────────────────────────────────────────────────
// Runs the EXACT judge() path used on the live seam, against the bundled good
// and bad mock notifiers. good MUST pass; bad MUST fail (negative control fires).
//   injected: the bad notifier genuinely returned delivered:false with status
//             "error" — a delivery failure was actually exercised (the violation
//             is provably present, not an empty/unmatched run).
//   fired:    good=pass && bad=fail — the validator condemned the bad notifier
//             and cleared the good one.
async function selfGuard() {
  let goodMod, badMod;
  try {
    goodMod = await import(FIX_GOOD);
    badMod = await import(FIX_BAD);
  } catch (e) {
    return { ok: false, injected: false, fired: false,
      note: `self-guard FAILED: fixture notifiers unimportable: ${e.message}` };
  }

  const good = await judge(goodMod.send_alert);
  const bad = await judge(badMod.send_alert);

  // injected: the bad notifier really exercised a delivery FAILURE — delivered
  // false AND status "error" (a wired-but-failed channel), distinct from the
  // not-wired stub. This proves the negative control is genuinely present.
  const injected = bad.delivered === false && bad.notifierStatus === "error";
  const fired = good.status === "pass" && bad.status === "fail";

  if (!injected) {
    return { ok: false, injected, fired,
      note: `self-guard FAILED: bad notifier returned delivered=${bad.delivered}, ` +
            `status=${JSON.stringify(bad.notifierStatus)} — the failed-delivery ` +
            `negative control could not be injected` };
  }
  if (!fired) {
    return { ok: false, injected, fired,
      note: `self-guard FAILED: good judged ${good.status}, bad judged ${bad.status} — ` +
            `expected good=pass & bad=fail; negative control did not fire cleanly` };
  }
  return { ok: true, injected, fired,
    note: `self-guard OK: bad notifier flagged fail (delivered:false/status:error — ` +
          `wired channel that did not deliver), good notifier clean pass ` +
          `(delivered:true/status:delivered)` };
}

// ── Run against a notifier (live seam by default, or --notifier fixture) ──────
async function run(sendAlertFn, mode) {
  const r = new Result(CONTROL, SURFACE);

  const sg = await selfGuard();
  r.negativeControl({ injected: sg.injected, fired: sg.fired, note: sg.note });
  if (!sg.ok) {
    return r.set("unknown", { evidence: sg.note,
      message: "alert-route check self-guard failed — verdict not trustworthy" });
  }

  const j = await judge(sendAlertFn);

  if (j.status === "unknown") {
    return r.set("unknown", {
      evidence: `${mode} judge: ${j.evidence}. The alert channel is STUBBED ` +
                `(notify/notify.mjs — n8n workflow pending); a not-wired seam is ` +
                `unverifiable, NOT a pass and NOT a fail. ${sg.note}`,
      message: "alert route NOT verified — channel stubbed, n8n workflow pending" });
  }
  if (j.status === "fail") {
    return r.set("fail", {
      evidence: `${mode} judge: ${j.evidence}. A wired channel that did not ` +
                `deliver is a real finding.`,
      message: j.message });
  }
  return r.set("pass", {
    evidence: `${mode} judge: ${j.evidence}. Test event provably reached a ` +
              `channel. ${sg.note}`,
    message: j.message });
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv) {
  if (argv.includes("--self-test")) {
    const sg = await selfGuard();
    console.log(JSON.stringify({ control: CONTROL, ok: sg.ok,
      injected: sg.injected, fired: sg.fired, note: sg.note }));
    return sg.ok ? 0 : 2;
  }

  const notifierPath = flag(argv, "--notifier");

  let sendAlertFn, mode;
  if (notifierPath) {
    let mod;
    try {
      mod = await import(resolvePath(process.cwd(), notifierPath));
    } catch (e) {
      const r = new Result(CONTROL, SURFACE);
      return emitResult(r.set("unknown", {
        evidence: `--notifier module unimportable: ${e.message}`,
        message: "alert-route: could not load --notifier" }));
    }
    if (typeof mod.send_alert !== "function") {
      const r = new Result(CONTROL, SURFACE);
      return emitResult(r.set("unknown", {
        evidence: `--notifier module exports no send_alert function`,
        message: "alert-route: --notifier has no send_alert export" }));
    }
    sendAlertFn = mod.send_alert;
    mode = "notifier";
  } else {
    // DEFAULT: judge against the REAL seam — the stub → unknown by construction.
    const live = await import("../notify/notify.mjs");
    sendAlertFn = live.send_alert;
    mode = "live";
  }

  return emitResult(await run(sendAlertFn, mode));
}

main(process.argv.slice(2)).then((code) => process.exit(code));
