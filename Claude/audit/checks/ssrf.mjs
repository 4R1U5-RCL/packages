#!/usr/bin/env node
// ssrf.mjs — CONTROL: ssrf   SURFACE: infra
//
// Asserts: the scraping/proxy path (Firecrawl, reached via n8n) REFUSES to
// fetch internal addresses. A scrape endpoint that will fetch
// http://127.0.0.1/ or http://169.254.169.254/ on an attacker's behalf is a
// Server-Side Request Forgery sink — the classic route to the cloud instance
// metadata API (T1552.005) and to anything else living on the trusted side of
// the network boundary.
//
// SHAPE (mirrors rls.mjs — the reference check):
//
//   1. SELF-GUARD FIRST (WORKING_METHOD §7/§8). Before trusting any verdict on
//      a live target, prove the detector still works against bundled fixtures:
//        - a GOOD mock scrape endpoint (blocks internal hosts) MUST be judged
//          `pass`,
//        - a BAD mock scrape endpoint (no SSRF guard) MUST be judged `fail`
//          (the negative control FIRES — our probe injects an internal target
//          and the detector catches that the endpoint fetched it).
//      If that does not hold, the detector is broken: emit `unknown`, never a
//      pass.
//   2. Only with a fired negative control do we probe the real --target.
//      _common.mjs structurally downgrades a pass without a fired negative
//      control, so a green here is always an earned green.
//
// PROBE MODEL against a live endpoint (POST / with JSON {url}, representing a
// scraper):
//   a. BENIGN baseline first — POST {url:"http://example.com/"}. A 2xx proves
//      the endpoint is alive and will handle a normal external fetch, so a later
//      "blocked" means ENFORCEMENT, not a dead endpoint. No sane baseline =>
//      unknown (never a silent pass).
//   b. INJECT internal targets — http://127.0.0.1/, http://169.254.169.254/,
//      http://localhost/, http://10.0.0.1/. If EVERY one is blocked (non-2xx or
//      an explicit {blocked:true}) => pass. If ANY is fetched (2xx ok) => fail
//      (SSRF possible — a real finding).
//
// Run:  node ssrf.mjs --target http://host:port   (probe a live scrape endpoint)
//       node ssrf.mjs --self-test                  (JSON; exit 0 ok / 2 broken)
//
// Node 22 built-ins only. No npm deps.

import net from "node:net";
import dns from "node:dns/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Result, emitResult } from "./_common.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const MOCK = join(PKG, "fixtures", "ssrf", "server.mjs");

const CONTROL = "ssrf";
const SURFACE = "infra";

// Targets the probe injects. Each names a different internal range so a partial
// allow-list (e.g. blocks 127/8 but not the metadata IP) is still caught.
export const INTERNAL_PROBES = [
  "http://127.0.0.1/",          // loopback
  "http://169.254.169.254/",    // link-local — cloud instance metadata
  "http://localhost/",          // hostname resolving to loopback
  "http://10.0.0.1/",           // RFC1918 private
];
const BENIGN_PROBE = "http://example.com/"; // external — must be allowed/alive

// ---------------------------------------------------------------------------
// HOST CLASSIFICATION (node:net + parsing; node:dns for bare hostnames).
// "internal" = loopback / private / link-local / unspecified. This is the same
// predicate the GOOD mock uses to decide what to block, so the fixture and the
// real-world expectation are defined exactly once.
// ---------------------------------------------------------------------------

function classifyIPv4(ip) {
  const o = ip.split(".").map(Number);
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null; // not a clean dotted quad
  }
  const [a, b] = o;
  if (a === 127) return "loopback";          // 127.0.0.0/8
  if (a === 0) return "unspecified";         // 0.0.0.0/8 ("this host")
  if (a === 10) return "private";            // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return "private"; // 172.16.0.0/12
  if (a === 192 && b === 168) return "private";          // 192.168.0.0/16
  if (a === 169 && b === 254) return "link-local";       // 169.254.0.0/16
  return null;
}

function classifyIPv6(ip) {
  const low = ip.toLowerCase();
  // IPv4-mapped / -compatible in DOTTED form (::ffff:127.0.0.1) — classify v4.
  const dotted = low.match(/(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/);
  if (dotted) {
    const v4 = classifyIPv4(dotted[1]);
    if (v4) return v4;
  }
  // IPv4-mapped in HEX form — new URL() normalizes ::ffff:127.0.0.1 to
  // ::ffff:7f00:1, so reconstruct the dotted quad from the last two groups.
  const hexMapped = low.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1], 16), lo = parseInt(hexMapped[2], 16);
    const v4 = classifyIPv4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
    if (v4) return v4;
  }
  if (low === "::1") return "loopback";
  if (low === "::") return "unspecified";
  // fe80::/10 link-local: fe80 .. febf
  if (/^fe[89ab][0-9a-f]:/.test(low)) return "link-local";
  // fc00::/7 unique-local: fc.. / fd..
  if (/^f[cd][0-9a-f]{2}:/.test(low)) return "private";
  return null;
}

// Returns { internal: boolean, why: string }. Async because bare hostnames
// must be resolved (a name pointing at 127.0.0.1 is just as dangerous as the
// literal IP).
export async function classifyHost(host) {
  if (host == null || host === "") return { internal: false, why: "empty host" };
  let h = String(host).trim();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1); // bracketed IPv6
  const low = h.toLowerCase();

  if (low === "localhost" || low.endsWith(".localhost")) {
    return { internal: true, why: "localhost name" };
  }

  const fam = net.isIP(h);
  if (fam === 4) {
    const c = classifyIPv4(h);
    return c ? { internal: true, why: `IPv4 ${c}` } : { internal: false, why: "IPv4 public" };
  }
  if (fam === 6) {
    const c = classifyIPv6(h);
    return c ? { internal: true, why: `IPv6 ${c}` } : { internal: false, why: "IPv6 public" };
  }

  // Bare hostname — resolve and classify every address it points to.
  let addrs;
  try {
    addrs = await dns.lookup(h, { all: true });
  } catch (e) {
    return { internal: false, why: `unresolvable (${e.code || e.message})` };
  }
  for (const { address } of addrs) {
    const fam2 = net.isIP(address);
    const c = fam2 === 4 ? classifyIPv4(address) : classifyIPv6(address);
    if (c) return { internal: true, why: `resolves to ${address} (${c})` };
  }
  return { internal: false, why: `resolves to public address(es)` };
}

export async function urlIsInternal(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return { internal: false, why: "unparseable url" }; }
  return classifyHost(u.hostname);
}

// ---------------------------------------------------------------------------
// PROBE — POST {url} to a scrape endpoint and read its disposition.
// ---------------------------------------------------------------------------

async function postScrape(baseUrl, targetUrl, timeoutMs = 4000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: targetUrl }),
      signal: ac.signal,
    });
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON body is fine */ }
    return { ok: true, status: res.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: null, error: e.code || e.message };
  }
}

// Did the endpoint FETCH the target (SSRF) or BLOCK it?
function disposition(resp) {
  if (!resp.ok) return { fetched: false, blocked: false, transportError: resp.error };
  const twoxx = resp.status >= 200 && resp.status < 300;
  const explicitBlock = !!(resp.body && resp.body.blocked === true);
  const explicitOkFalse = !!(resp.body && resp.body.ok === false);
  const fetched = twoxx && !explicitBlock && !explicitOkFalse;
  return { fetched, blocked: !fetched, transportError: null };
}

// Probe one endpoint end to end. Returns a plain verdict (no negative control —
// that is recorded by the caller). status ∈ pass|fail|unknown.
export async function classifyEndpoint(baseUrl) {
  // (a) benign external baseline — must be alive and handle a normal fetch.
  const benign = await postScrape(baseUrl, BENIGN_PROBE);
  if (!benign.ok) {
    return {
      status: "unknown",
      injectedInternal: false,
      evidence: `benign external probe to ${baseUrl} (${BENIGN_PROBE}) failed at ` +
                `transport: ${benign.error} — endpoint unreachable, cannot establish ` +
                `a live baseline`,
      message: "SSRF: scrape endpoint unreachable (unverifiable)",
    };
  }
  const benignDisp = disposition(benign);
  if (!benignDisp.fetched) {
    return {
      status: "unknown",
      injectedInternal: false,
      evidence: `benign external probe (${BENIGN_PROBE}) was not handled normally ` +
                `(status=${benign.status}, body=${JSON.stringify(benign.body)}) — ` +
                `cannot tell enforcement from a dead/over-blocking endpoint`,
      message: "SSRF: no sane external baseline (unverifiable)",
    };
  }

  // (b) inject internal targets — the bad input.
  const fetchedInternal = [];
  const blockedInternal = [];
  for (const probe of INTERNAL_PROBES) {
    const resp = await postScrape(baseUrl, probe);
    const d = disposition(resp);
    if (d.transportError) {
      // Endpoint answered benign but errors on this probe — inconclusive.
      return {
        status: "unknown",
        injectedInternal: true,
        evidence: `internal probe ${probe} errored at transport: ${d.transportError} ` +
                  `(benign baseline was fine) — inconclusive`,
        message: "SSRF: internal probe transport error (unverifiable)",
      };
    }
    if (d.fetched) fetchedInternal.push(`${probe} -> status ${resp.status} ${JSON.stringify(resp.body)}`);
    else blockedInternal.push(`${probe} -> status ${resp.status}`);
  }

  if (fetchedInternal.length) {
    return {
      status: "fail",
      injectedInternal: true,
      evidence: `endpoint FETCHED ${fetchedInternal.length} internal target(s) — SSRF ` +
                `possible: ${fetchedInternal.join("; ")}`,
      message: `SSRF: scrape endpoint fetched ${fetchedInternal.length} internal target(s)`,
    };
  }
  return {
    status: "pass",
    injectedInternal: true,
    evidence: `all ${INTERNAL_PROBES.length} internal targets blocked ` +
              `(benign external ${BENIGN_PROBE} allowed): ${blockedInternal.join("; ")}`,
    message: "SSRF: scrape endpoint blocks every internal target",
  };
}

// ---------------------------------------------------------------------------
// SELF-GUARD — start the good and bad mocks, run the SAME classifyEndpoint()
// path against each, and require good=>pass / bad=>fail. This is the negative
// control: against the bad mock we INJECT an internal target and the detector
// must FIRE (verdict fail). If it does not, the check is broken => unknown.
// ---------------------------------------------------------------------------

export async function selfGuard() {
  let startMock;
  try { ({ startMock } = await import(MOCK)); }
  catch (e) {
    return { ok: false, injected: false, fired: false,
             note: `fixture mock unloadable: ${e.message}` };
  }

  let good, bad;
  try {
    good = await startMock("good");
    bad = await startMock("bad");
  } catch (e) {
    if (good) await good.close();
    return { ok: false, injected: false, fired: false,
             note: `could not start mock endpoints: ${e.message}` };
  }

  try {
    const g = await classifyEndpoint(good.url);
    const b = await classifyEndpoint(bad.url);

    const injected = g.injectedInternal && b.injectedInternal; // bad input reached both
    const fired = g.status === "pass" && b.status === "fail";  // detector behaved

    if (!injected) {
      return { ok: false, injected, fired,
        note: `self-guard FAILED: could not inject internal probes ` +
              `(good.injected=${g.injectedInternal}, bad.injected=${b.injectedInternal}; ` +
              `good=${g.status}, bad=${b.status})` };
    }
    if (!fired) {
      return { ok: false, injected, fired,
        note: `self-guard FAILED: detector misbehaved — expected good=pass/bad=fail, ` +
              `got good=${g.status}, bad=${b.status}` };
    }
    return { ok: true, injected, fired,
      note: `self-guard OK: GOOD mock (${good.url}) judged pass, BAD mock (${bad.url}) ` +
            `judged fail — internal probe injected and the SSRF detector fired on the ` +
            `unguarded endpoint` };
  } finally {
    await good.close();
    await bad.close();
  }
}

// ---------------------------------------------------------------------------
// RUN against a real target.
// ---------------------------------------------------------------------------

async function run(target) {
  const r = new Result(CONTROL, SURFACE);
  const sg = await selfGuard();
  r.negativeControl({ injected: sg.injected, fired: sg.fired, note: sg.note });
  if (!sg.ok) {
    return r.set("unknown", { evidence: sg.note,
      message: "SSRF check self-guard failed — verdict not trustworthy" });
  }
  if (!target) {
    return r.set("unknown", {
      evidence: `self-guard passed (${sg.note}) but no --target given; nothing live to probe`,
      message: "SSRF: self-guard OK, no live target supplied (unverifiable)" });
  }

  const v = await classifyEndpoint(target);
  return r.set(v.status, {
    evidence: `target ${target}: ${v.evidence}. Self-guard: ${sg.note}`,
    message: v.message,
  });
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
  const target = (() => {
    const i = argv.indexOf("--target");
    return i >= 0 ? argv[i + 1] : null;
  })();
  return emitResult(await run(target));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
