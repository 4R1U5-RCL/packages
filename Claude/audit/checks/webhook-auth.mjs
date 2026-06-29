#!/usr/bin/env node
// webhook-auth.mjs — CONTROL: webhook-auth   SURFACE: infra
//
// Asserts: an inbound webhook endpoint AUTHENTICATES its caller. It must verify
// an HMAC-SHA256 signature over the raw body (n8n: `x-n8n-signature`) and reject
// anything unsigned or wrong-signed. An endpoint that 200s a forged payload has
// NO inbound auth — the TE-16 class (verdict + email-report routes shipped
// unsigned). This is an ACTIVE probe, not static analysis.
//
// Mirrors rls.mjs structure:
//   1. Read the FIXED manifest (manifests/webhook-auth.json) — header name,
//      replay window, FAKE test secret are not model discretion.
//   2. SELF-GUARD FIRST (WORKING_METHOD §7/§8). Spin up the bundled mock
//      receivers (fixtures/webhook-auth/server.mjs) and run the SAME probe path
//      used on the real target:
//        - the BAD receiver (accepts everything) MUST be flagged `fail`
//          (negative control FIRES — a known-vulnerable endpoint is caught),
//        - the GOOD receiver (HMAC-verified) MUST be judged `pass`
//          (guards against a probe that flags everything / false-positives).
//      If the self-guard does not hold, the probe is broken: emit `unknown`,
//      never a pass.
//   3. Probe the real --target. The forged payloads we inject ARE the negative
//      control: injected=true once sent, fired=true when BOTH are rejected.
//      _common.mjs structurally downgrades a pass whose negative control did not
//      fire.
//
// Status mapping for the real target:
//   - unreachable, or the CORRECTLY-SIGNED payload is NOT accepted  -> unknown
//     (cannot tell a dead/broken endpoint from an enforcing one)
//   - correctly-signed accepted AND unsigned+wrong-sig both rejected -> pass
//   - any unsigned/wrong-sig payload accepted (no auth)             -> fail
//
// Run:  node webhook-auth.mjs --target http://host/webhook --secret <s>
//       node webhook-auth.mjs --self-test

import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Result, emitResult, EXIT } from "./_common.mjs";
import {
  startGoodReceiver,
  startBadReceiver,
  sign,
  FAKE_SECRET,
} from "../fixtures/webhook-auth/server.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const MANIFEST = join(PKG, "manifests", "webhook-auth.json");

const CONTROL = "webhook-auth";
const SURFACE = "infra";

function loadManifest() {
  return JSON.parse(readFileSync(MANIFEST, "utf8"));
}

// Single HTTP POST. Resolves { status } on any HTTP response, or { error } if
// the endpoint is unreachable / times out. Never throws — the caller decides
// what an error means (almost always: unknown).
function post(url, { body, headers, timeoutMs = 4000 }) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return resolve({ error: `bad url: ${e.message}` });
    }
    const data = Buffer.from(body ?? "", "utf8");
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": data.length,
          ...headers,
        },
      },
      (res) => {
        res.resume(); // drain
        res.on("end", () => resolve({ status: res.statusCode }));
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve({ error: "timeout" });
    });
    req.on("error", (e) => resolve({ error: e.message }));
    req.write(data);
    req.end();
  });
}

const accepted = (r) => r.status >= 200 && r.status < 300;
const rejected = (r) => r.status === 401 || r.status === 403;

// The core probe. Sends three payloads against `url`:
//   valid     — correctly signed with `secret` over the raw body (+ timestamp)
//   unsigned  — no signature header at all
//   wrongSig  — a syntactically-valid but WRONG signature
// Returns a structured observation; classification is done by classify().
async function probe(url, secret, manifest) {
  const sigHeader = manifest.signature_header || "x-n8n-signature";
  const tsHeader = manifest.timestamp_header || "x-n8n-timestamp";
  const now = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ event: "audit.probe", ts: now });

  const validSig = sign(secret, body);
  const wrongSig = sign(secret + "-tampered", body); // valid hex, wrong key

  const valid = await post(url, {
    body,
    headers: { [sigHeader]: validSig, [tsHeader]: String(now) },
  });
  const unsigned = await post(url, {
    body,
    headers: { [tsHeader]: String(now) },
  });
  const wrong = await post(url, {
    body,
    headers: { [sigHeader]: wrongSig, [tsHeader]: String(now) },
  });

  return { valid, unsigned, wrong };
}

// Turn an observation into a verdict + negative-control bookkeeping.
//   injected: the forged payloads were actually SENT (got an HTTP response).
//   fired:    BOTH forged payloads were rejected (the auth control caught them).
function classify(obs) {
  const { valid, unsigned, wrong } = obs;

  // Unreachable: the valid request never got an HTTP response.
  if (valid.error) {
    return {
      status: "unknown",
      injected: false,
      fired: false,
      detail: `endpoint unreachable on the signed request (${valid.error}) — ` +
              `cannot probe enforcement`,
    };
  }
  // The forged payloads count as "injected" only if they actually reached the
  // endpoint (got a response), not if the network ate them.
  const injected = !unsigned.error && !wrong.error;
  const unsignedRej = !unsigned.error && rejected(unsigned);
  const wrongRej = !wrong.error && rejected(wrong);
  const fired = injected && unsignedRej && wrongRej;

  const s = (r) => (r.error ? `err:${r.error}` : r.status);
  const detail =
    `signed=${s(valid)} unsigned=${s(unsigned)} wrong-sig=${s(wrong)} ` +
    `[header=${"x-n8n-signature"}]`;

  // The correctly-signed payload must be accepted, else we cannot distinguish a
  // properly-enforcing endpoint from a dead/broken/everything-rejecting one.
  if (!accepted(valid)) {
    return {
      status: "unknown",
      injected,
      fired,
      detail: `the correctly-signed payload was NOT accepted (${s(valid)}); ` +
              `cannot tell enforcement from a dead/broken endpoint — ${detail}`,
    };
  }
  // Signed accepted. Now: did any forged payload slip through?
  if (!injected) {
    return {
      status: "unknown",
      injected,
      fired,
      detail: `forged payloads could not be injected (network error) — ${detail}`,
    };
  }
  if (unsignedRej && wrongRej) {
    return { status: "pass", injected, fired, detail };
  }
  const slipped = [];
  if (!unsignedRej) slipped.push("unsigned");
  if (!wrongRej) slipped.push("wrong-signature");
  return {
    status: "fail",
    injected,
    fired,
    detail: `endpoint ACCEPTED ${slipped.join(" + ")} payload(s) — no inbound ` +
            `HMAC auth — ${detail}`,
  };
}

// Self-guard: run the exact probe+classify path against the bundled mock
// receivers. Proves (a) the negative control fires — a known-vulnerable (BAD)
// endpoint is flagged `fail`, and (b) no false positives — a correctly-secured
// (GOOD) endpoint is judged `pass`. Returns { ok, injected, fired, note }.
async function selfGuard(manifest) {
  let good, bad;
  try {
    good = await startGoodReceiver({ secret: FAKE_SECRET });
    bad = await startBadReceiver();
  } catch (e) {
    return { ok: false, injected: false, fired: false,
             note: `mock receivers failed to start: ${e.message}` };
  }
  try {
    const goodV = classify(await probe(good.url, FAKE_SECRET, manifest));
    const badV = classify(await probe(bad.url, FAKE_SECRET, manifest));

    // Negative control = the BAD (vulnerable) receiver: we injected forged
    // payloads and they were ACCEPTED, and our probe flagged it `fail`.
    const injected = badV.injected;          // forged payloads reached it
    const fired = badV.status === "fail";    // our detector caught the vuln
    const goodOk = goodV.status === "pass";  // no false positive

    if (!fired) {
      return { ok: false, injected, fired,
        note: `self-guard FAILED: BAD mock judged '${badV.status}', expected ` +
              `'fail' — negative control did not fire (${badV.detail})` };
    }
    if (!goodOk) {
      return { ok: false, injected, fired,
        note: `self-guard FAILED: GOOD mock judged '${goodV.status}', expected ` +
              `'pass' — probe false-positives, cannot trust it (${goodV.detail})` };
    }
    return { ok: true, injected, fired,
      note: `self-guard OK: BAD mock flagged 'fail' (${badV.detail}); ` +
            `GOOD mock judged 'pass' (${goodV.detail})` };
  } finally {
    await good.close();
    await bad.close();
  }
}

async function run(target, secret) {
  const manifest = loadManifest();
  const r = new Result(CONTROL, SURFACE);

  const sg = await selfGuard(manifest);
  if (!sg.ok) {
    r.negativeControl({ injected: sg.injected, fired: sg.fired, note: sg.note });
    return r.set("unknown", { evidence: sg.note,
      message: "webhook-auth self-guard failed — verdict not trustworthy" });
  }

  if (!target) {
    r.negativeControl({ injected: false, fired: false,
      note: `self-guard OK but no --target given; ${sg.note}` });
    return r.set("unknown", {
      evidence: "no --target supplied — nothing to probe",
      message: "webhook-auth: no target endpoint to probe" });
  }
  if (!secret) {
    r.negativeControl({ injected: false, fired: false,
      note: `self-guard OK but no --secret given; ${sg.note}` });
    return r.set("unknown", {
      evidence: "no --secret supplied — cannot sign the valid payload",
      message: "webhook-auth: no signing secret provided" });
  }

  const verdict = classify(await probe(target, secret, manifest));
  // The forged payloads sent to the REAL target are this verdict's negative
  // control: injected=they were sent, fired=both rejected.
  r.negativeControl({ injected: verdict.injected, fired: verdict.fired,
    note: `live injection against ${target}: ` +
          `injected=${verdict.injected} fired=${verdict.fired}. ${sg.note}` });

  const msg = {
    pass: "inbound webhook authenticates: signed accepted, forged rejected",
    fail: "inbound webhook has NO auth: a forged payload was accepted",
    unknown: "webhook-auth: could not determine enforcement",
  }[verdict.status];
  return r.set(verdict.status, { evidence: verdict.detail, message: msg });
}

function getFlag(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith("--")
    ? argv[i + 1]
    : undefined;
}

async function main(argv) {
  const manifest = loadManifest();
  if (argv.includes("--self-test")) {
    const sg = await selfGuard(manifest);
    console.log(JSON.stringify({ control: CONTROL, ok: sg.ok,
      self_guard_ok: sg.ok, injected: sg.injected, fired: sg.fired,
      note: sg.note }));
    return sg.ok ? 0 : 2;
  }
  const target = getFlag(argv, "target");
  const secret = getFlag(argv, "secret");
  return emitResult(await run(target, secret));
}

main(process.argv.slice(2)).then((code) => process.exit(code));
