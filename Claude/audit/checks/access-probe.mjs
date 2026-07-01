#!/usr/bin/env node
// access-probe.mjs — CONTROL: access-probe   SURFACE: app   REACHABILITY: dynamic
//
// OWASP A01: Broken Access Control (object-level / IDOR). Asserts the running
// app enforces OWNERSHIP on per-user objects: an authenticated user A must NOT
// be able to read user B's record by guessing/altering its id.
//
// This is the SAME access-control boundary the repo-surface `rls`/`revoke`
// checks verify in policy — tested here from OUTSIDE, against the live app.
// access-probe does not re-implement RLS reasoning; migration-policy correctness
// stays single-homed in rls.mjs/revoke.mjs. One boundary, two surfaces.
//
// SHAPE (mirrors ssrf.mjs — the dynamic reference check):
//
//   1. SELF-GUARD FIRST (WORKING_METHOD §7/§8). Prove the detector still works
//      against bundled mocks (fixtures/access-probe/):
//        - GOOD app (enforces ownership) MUST be judged `pass`,
//        - BAD app (IDOR sink) MUST be judged `fail` — the negative control
//          FIRES: user A's token reads user B's record and the detector catches
//          that cross-user read succeeded.
//      If that does not hold, the detector is broken: emit `unknown`, never pass.
//   2. Only with a fired negative control do we probe the real --target.
//      _common.mjs structurally downgrades a pass without a fired negative
//      control, so a green here is always earned.
//
// PROBE MODEL (GET ${base}record/${id} with `Authorization: Bearer <token>`):
//   a. OWNERSHIP BASELINE — user A reads A's OWN record. A 2xx proves the
//      endpoint is alive and A is a legitimate session, so a later "denied" on
//      B's record means ENFORCEMENT, not a dead/over-blocking endpoint. No sane
//      baseline => unknown (never a silent pass).
//   b. INJECT the cross-user read — user A's token requests B's record id. If it
//      is DENIED (non-2xx or {denied:true}) => pass. If B's record is RETURNED
//      (2xx with the data) => fail (IDOR — a real finding).
//
// Run:  node access-probe.mjs --target http://host/ --own-token T --own-id I \
//                             --foreign-id J [--resource "record/{id}"]
//       node access-probe.mjs --self-test
//
// Node 22 built-ins only. No npm deps.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Result, emitResult } from "./_common.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const MOCK = join(PKG, "fixtures", "access-probe", "server.mjs");

const CONTROL = "access-probe";
const SURFACE = "app";
const REACHABILITY = "dynamic";
const DEFAULT_RESOURCE = "record/{id}";

// ---------------------------------------------------------------------------
// PROBE — GET a record as a given user, read the disposition.
// ---------------------------------------------------------------------------

function recordUrl(baseUrl, resource, id) {
  const base = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";
  return base + resource.replace("{id}", encodeURIComponent(id));
}

async function getRecord(baseUrl, resource, id, token, timeoutMs = 4000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(recordUrl(baseUrl, resource, id), {
      method: "GET",
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: ac.signal,
    });
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON body is fine */ }
    return { ok: true, status: res.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: null, error: e.code || e.message };
  } finally {
    clearTimeout(t);
  }
}

// Did the request RETURN the protected object, or was it DENIED?
function disposition(resp) {
  if (!resp.ok) return { returned: false, denied: false, transportError: resp.error };
  const twoxx = resp.status >= 200 && resp.status < 300;
  const explicitDeny = !!(resp.body && (resp.body.denied === true || resp.body.ok === false));
  const returned = twoxx && !explicitDeny;
  return { returned, denied: !returned, transportError: null };
}

// Probe one endpoint end to end. Returns a plain verdict (no negative control —
// recorded by the caller). status ∈ pass|fail|unknown. `injectedCrossUser` says
// whether the bad input (A reading B) was actually exercised.
export async function classifyEndpoint(baseUrl, { ownToken, ownId, foreignId, resource = DEFAULT_RESOURCE }) {
  // (a) ownership baseline — A reads A's own record; must succeed.
  const own = await getRecord(baseUrl, resource, ownId, ownToken);
  if (!own.ok) {
    return { status: "unknown", injectedCrossUser: false,
      evidence: `ownership baseline (user reads own record ${ownId}) failed at transport: ` +
                `${own.error} — endpoint unreachable, cannot establish a live baseline`,
      message: "access-probe: app endpoint unreachable (unverifiable)" };
  }
  const ownDisp = disposition(own);
  if (!ownDisp.returned) {
    return { status: "unknown", injectedCrossUser: false,
      evidence: `ownership baseline (user reads own record ${ownId}) was not served ` +
                `(status=${own.status}, body=${JSON.stringify(own.body)}) — cannot tell ` +
                `enforcement from a dead/over-blocking endpoint or wrong credentials`,
      message: "access-probe: no sane ownership baseline (unverifiable)" };
  }

  // (b) inject the cross-user read — A's token requests B's record. THE bad input.
  const cross = await getRecord(baseUrl, resource, foreignId, ownToken);
  const d = disposition(cross);
  if (d.transportError) {
    return { status: "unknown", injectedCrossUser: true,
      evidence: `cross-user read (A's token -> record ${foreignId}) errored at transport: ` +
                `${d.transportError} (baseline was fine) — inconclusive`,
      message: "access-probe: cross-user probe transport error (unverifiable)" };
  }
  if (d.returned) {
    return { status: "fail", injectedCrossUser: true,
      evidence: `IDOR: user A's token READ record ${foreignId} it does not own ` +
                `(status=${cross.status}, body=${JSON.stringify(cross.body)}) — broken object-level access control`,
      message: `access-probe: IDOR — cross-user read of record ${foreignId} succeeded` };
  }
  return { status: "pass", injectedCrossUser: true,
    evidence: `cross-user read denied (A's token -> record ${foreignId}: status ${cross.status} ` +
              `${JSON.stringify(cross.body)}); ownership baseline (own record ${ownId}) served — enforcement confirmed`,
    message: "access-probe: object-level access control enforced (cross-user read denied)" };
}

// ---------------------------------------------------------------------------
// SELF-GUARD — start good+bad mocks, run the SAME classifyEndpoint() against
// each, require good=>pass / bad=>fail. Negative control = the bad mock: A reads
// B and the detector must fire (verdict fail). Else the check is broken=>unknown.
// ---------------------------------------------------------------------------

export async function selfGuard() {
  let startMock, FIXTURE;
  try { ({ startMock, FIXTURE } = await import(MOCK)); }
  catch (e) {
    return { ok: false, injected: false, fired: false, note: `fixture mock unloadable: ${e.message}` };
  }

  let good, bad;
  try { good = await startMock("good"); bad = await startMock("bad"); }
  catch (e) {
    if (good) await good.close();
    return { ok: false, injected: false, fired: false, note: `could not start mock apps: ${e.message}` };
  }

  try {
    const params = { ownToken: FIXTURE.ownToken, ownId: FIXTURE.ownId, foreignId: FIXTURE.foreignId };
    const g = await classifyEndpoint(good.url, params);
    const b = await classifyEndpoint(bad.url, params);

    const injected = g.injectedCrossUser && b.injectedCrossUser; // bad input exercised on both
    const fired = g.status === "pass" && b.status === "fail";     // detector behaved

    if (!injected) {
      return { ok: false, injected, fired,
        note: `self-guard FAILED: could not inject the cross-user read ` +
              `(good.injected=${g.injectedCrossUser}, bad.injected=${b.injectedCrossUser}; ` +
              `good=${g.status}, bad=${b.status})` };
    }
    if (!fired) {
      return { ok: false, injected, fired,
        note: `self-guard FAILED: detector misbehaved — expected good=pass/bad=fail, ` +
              `got good=${g.status}, bad=${b.status}` };
    }
    return { ok: true, injected, fired,
      note: `self-guard OK: GOOD app (${good.url}) judged pass, BAD app (${bad.url}) judged fail — ` +
            `cross-user read injected and the IDOR detector fired on the unguarded app` };
  } finally {
    await good.close();
    await bad.close();
  }
}

// ---------------------------------------------------------------------------
// RUN against a real target.
// ---------------------------------------------------------------------------

async function run(target, params) {
  const r = new Result(CONTROL, SURFACE, REACHABILITY);
  const sg = await selfGuard();
  r.negativeControl({ injected: sg.injected, fired: sg.fired, note: sg.note });
  if (!sg.ok) {
    return r.set("unknown", { evidence: sg.note,
      message: "access-probe self-guard failed — verdict not trustworthy" });
  }
  if (!target) {
    return r.set("unknown", {
      evidence: `self-guard passed (${sg.note}) but no --target given; nothing live to probe`,
      message: "access-probe: self-guard OK, no live target supplied (unverifiable)" });
  }
  if (!params.ownToken || !params.ownId || !params.foreignId) {
    return r.set("unknown", {
      evidence: `self-guard passed but a live probe needs --own-token, --own-id and --foreign-id ` +
                `(got ownToken=${!!params.ownToken}, ownId=${params.ownId}, foreignId=${params.foreignId})`,
      message: "access-probe: missing credentials/ids for a live probe (unverifiable)" });
  }

  const v = await classifyEndpoint(target, params);
  return r.set(v.status, { evidence: `target ${target}: ${v.evidence}. Self-guard: ${sg.note}`, message: v.message });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(argv) {
  if (argv.includes("--self-test")) {
    const sg = await selfGuard();
    console.log(JSON.stringify({ control: CONTROL, self_guard_ok: sg.ok,
      injected: sg.injected, fired: sg.fired, note: sg.note }));
    return sg.ok ? 0 : 2;
  }
  const get = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const target = get("--target");
  const params = {
    ownToken: get("--own-token"),
    ownId: get("--own-id"),
    foreignId: get("--foreign-id"),
    resource: get("--resource") || DEFAULT_RESOURCE,
  };
  return emitResult(await run(target, params));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
