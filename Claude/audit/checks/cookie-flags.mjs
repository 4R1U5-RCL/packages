#!/usr/bin/env node
// cookie-flags.mjs — CONTROL: cookie-flags   SURFACE: app   REACHABILITY: dynamic
//
// OWASP A07: Identification and Authentication Failures. Asserts the running app
// sets its SESSION cookie with the three hardening flags: HttpOnly (no JS theft
// via XSS), Secure (never sent over plaintext), and SameSite (CSRF mitigation).
//
// SHAPE (mirrors access-probe.mjs — the dynamic reference check):
//
//   1. SELF-GUARD FIRST (WORKING_METHOD §7/§8). Prove the detector still works
//      against bundled mocks (fixtures/cookie-flags/):
//        - GOOD app (sets sid=...; HttpOnly; Secure; SameSite) MUST be `pass`,
//        - BAD app (sets sid=...; Path=/ with NO flags) MUST be `fail` — the
//          negative control FIRES: a flagless session cookie was injected and
//          the missing-flags detector caught it.
//      If that does not hold, the detector is broken: emit `unknown`, never pass.
//   2. Only with a fired negative control do we probe the real --target.
//      _common.mjs structurally downgrades a pass without a fired negative
//      control, so a green here is always earned.
//
// PROBE MODEL (GET ${base}${path}, default /login):
//   BASELINE — the endpoint must actually emit a Set-Cookie for the named
//     session cookie. If NO Set-Cookie / the named cookie is absent => unknown
//     ("no session cookie to judge"). Never a silent pass, never a fail.
//   VERDICT — session cookie present:
//     all three flags (HttpOnly, Secure, SameSite=<any>) present => pass.
//     missing >=1 flag => fail (lists the missing flags — a real finding).
//
// Run:  node cookie-flags.mjs --target http://host/ [--cookie-name sid] [--path /login]
//       node cookie-flags.mjs --self-test
//
// Node 22 built-ins only. No npm deps.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Result, emitResult } from "./_common.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const MOCK = join(PKG, "fixtures", "cookie-flags", "server.mjs");

const CONTROL = "cookie-flags";
const SURFACE = "app";
const REACHABILITY = "dynamic";
const DEFAULT_COOKIE = "sid";
const DEFAULT_PATH = "/login";

// ---------------------------------------------------------------------------
// PROBE — GET the endpoint, read the Set-Cookie header(s).
// ---------------------------------------------------------------------------

function loginUrl(baseUrl, path) {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const p = path.startsWith("/") ? path : "/" + path;
  return base + p;
}

async function fetchCookies(baseUrl, path, timeoutMs = 4000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(loginUrl(baseUrl, path), { method: "GET", signal: ac.signal });
    // Node 22: getSetCookie() returns an array of raw Set-Cookie strings.
    let cookies = [];
    if (typeof res.headers.getSetCookie === "function") {
      cookies = res.headers.getSetCookie();
    }
    if ((!cookies || cookies.length === 0)) {
      const raw = res.headers.get("set-cookie");
      if (raw) cookies = [raw];
    }
    return { ok: true, status: res.status, cookies: cookies || [] };
  } catch (e) {
    return { ok: false, status: 0, cookies: [], error: e.code || e.message };
  } finally {
    clearTimeout(t);
  }
}

// Find the raw Set-Cookie string that sets the named session cookie.
function findSessionCookie(cookies, name) {
  const lname = name.toLowerCase();
  for (const c of cookies) {
    const eq = c.indexOf("=");
    if (eq < 0) continue;
    const key = c.slice(0, eq).trim().toLowerCase();
    if (key === lname) return c;
  }
  return null;
}

// Which of HttpOnly / Secure / SameSite are MISSING from a raw cookie string?
function missingFlags(rawCookie) {
  const attrs = rawCookie.split(";").slice(1).map((a) => a.trim().toLowerCase());
  const has = (flag) => attrs.some((a) => a === flag || a.startsWith(flag + "="));
  const missing = [];
  if (!has("httponly")) missing.push("HttpOnly");
  if (!has("secure")) missing.push("Secure");
  if (!has("samesite")) missing.push("SameSite");
  return missing;
}

// Probe one endpoint end to end. Returns a plain verdict (no negative control —
// recorded by the caller). status ∈ pass|fail|unknown. `cookieObserved` says
// whether a session cookie was actually seen to judge (the analogue of
// access-probe's `injectedCrossUser`).
export async function classifyEndpoint(baseUrl, { cookieName = DEFAULT_COOKIE, path = DEFAULT_PATH } = {}) {
  const resp = await fetchCookies(baseUrl, path);
  if (!resp.ok) {
    return { status: "unknown", cookieObserved: false,
      evidence: `GET ${loginUrl(baseUrl, path)} failed at transport: ${resp.error} — ` +
                `endpoint unreachable, cannot read a Set-Cookie`,
      message: "cookie-flags: app endpoint unreachable (unverifiable)" };
  }

  const raw = findSessionCookie(resp.cookies, cookieName);
  if (!raw) {
    return { status: "unknown", cookieObserved: false,
      evidence: `endpoint ${loginUrl(baseUrl, path)} (status=${resp.status}) emitted ` +
                `${resp.cookies.length} Set-Cookie header(s) but none set the session ` +
                `cookie "${cookieName}" — no session cookie to judge / endpoint did not set one`,
      message: "cookie-flags: no session cookie to judge (unverifiable)" };
  }

  const missing = missingFlags(raw);
  if (missing.length > 0) {
    return { status: "fail", cookieObserved: true,
      evidence: `session cookie "${cookieName}" set as \`${raw}\` is MISSING flag(s): ` +
                `${missing.join(", ")} — weak session cookie (OWASP A07)`,
      message: `cookie-flags: session cookie missing ${missing.join(", ")}` };
  }
  return { status: "pass", cookieObserved: true,
    evidence: `session cookie "${cookieName}" set as \`${raw}\` carries HttpOnly, Secure ` +
              `and SameSite — hardened session cookie`,
    message: "cookie-flags: session cookie hardened (HttpOnly + Secure + SameSite)" };
}

// ---------------------------------------------------------------------------
// SELF-GUARD — start good+bad mocks, run the SAME classifyEndpoint() against
// each, require good=>pass / bad=>fail. Negative control = the bad mock: a
// flagless session cookie is set and the detector must fire (verdict fail). Else
// the check is broken => unknown.
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
    const params = { cookieName: FIXTURE.cookieName, path: FIXTURE.path };
    const g = await classifyEndpoint(good.url, params);
    const b = await classifyEndpoint(bad.url, params);

    const injected = g.cookieObserved && b.cookieObserved; // a cookie was present to judge on both
    const fired = g.status === "pass" && b.status === "fail"; // detector behaved

    if (!injected) {
      return { ok: false, injected, fired,
        note: `self-guard FAILED: could not observe a session cookie to judge ` +
              `(good.cookieObserved=${g.cookieObserved}, bad.cookieObserved=${b.cookieObserved}; ` +
              `good=${g.status}, bad=${b.status})` };
    }
    if (!fired) {
      return { ok: false, injected, fired,
        note: `self-guard FAILED: detector misbehaved — expected good=pass/bad=fail, ` +
              `got good=${g.status}, bad=${b.status}` };
    }
    return { ok: true, injected, fired,
      note: `self-guard OK: GOOD app (${good.url}) judged pass, BAD app (${bad.url}) judged fail — ` +
            `flagless session cookie injected and the missing-flags detector fired on the unguarded app` };
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
      message: "cookie-flags self-guard failed — verdict not trustworthy" });
  }
  if (!target) {
    return r.set("unknown", {
      evidence: `self-guard passed (${sg.note}) but no --target given; nothing live to probe`,
      message: "cookie-flags: self-guard OK, no live target supplied (unverifiable)" });
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
    cookieName: get("--cookie-name") || DEFAULT_COOKIE,
    path: get("--path") || DEFAULT_PATH,
  };
  return emitResult(await run(target, params));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
