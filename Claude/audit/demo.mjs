#!/usr/bin/env node
// demo.mjs — the demonstration run (WORKING_METHOD §3: smoke-test the package
// itself, then the E-round).
//
// For EVERY check it asserts the three things that make a check real:
//   1. --self-test  => self-guard ok (the detector still works)
//   2. good target  => status "pass", exit 0
//   3. bad target   => status "fail", exit 1, AND the negative control is shown
//      to have been injected (the bad input was provably present)
//
// Then it runs the real repo-surface dispatch against /studio to show the
// wrapper layer (run.mjs) didn't introduce a false pass the core would catch.
//
// Exit 0 only if every assertion holds. This is the package proving, about
// itself, the one thing it exists to prove: it does not false-pass.

import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PKG = dirname(fileURLToPath(import.meta.url));
const node = process.execPath;

function check(control, args) {
  const r = spawnSync(node, [join(PKG, "checks", `${control}.mjs`), ...args],
                      { cwd: PKG, encoding: "utf8" });
  const line = (r.stdout || "").trim().split("\n").filter(Boolean).pop();
  let obj = null;
  try { obj = JSON.parse(line); } catch { /* leave null */ }
  return { exit: r.status, obj, stderr: r.stderr };
}

function selfTest(control) {
  const r = spawnSync(node, [join(PKG, "checks", `${control}.mjs`), "--self-test"],
                      { cwd: PKG, encoding: "utf8" });
  let obj = null;
  try { obj = JSON.parse((r.stdout || "").trim().split("\n").pop()); } catch { /* */ }
  return { exit: r.status, ok: obj && (obj.ok ?? obj.self_guard_ok) === true, obj };
}

// Read the first JSON line a long-running mock prints, then hand control back.
function firstLine(child) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl >= 0) { child.stdout.off("data", onData); resolve(buf.slice(0, nl)); }
    };
    child.stdout.on("data", onData);
    child.on("error", reject);
    setTimeout(() => reject(new Error("mock did not announce a url in time")), 5000);
  });
}

async function webhookCase(mode) {
  const srv = spawn(node, [join(PKG, "fixtures", "webhook-auth", "server.mjs"),
                           "--mode", mode], { cwd: PKG });
  try {
    const info = JSON.parse(await firstLine(srv));
    return check("webhook-auth", ["--target", info.url, "--secret", info.secret]);
  } finally { srv.kill(); }
}

// Generic harness for the app:dynamic checks whose fixture server prints a
// "URL=<base>" first line and stays alive (access-probe, cookie-flags). Start
// the good/bad mock, read its URL, run the check against it, kill the mock.
async function serverCase(control, serverPath, mode, extraArgs = []) {
  const srv = spawn(node, [serverPath, mode], { cwd: PKG });
  try {
    const line = await firstLine(srv);                 // "URL=http://127.0.0.1:PORT/"
    const url = line.replace(/^URL=/, "").trim();
    return check(control, ["--target", url, ...extraArgs]);
  } finally { srv.kill(); }
}

// The app:dynamic checks: which fixture server, and any extra argv the check
// needs (access-probe carries the fixture's tokens/ids).
const SERVER_CASES = {
  "access-probe": {
    server: join(PKG, "fixtures", "access-probe", "server.mjs"),
    extra: ["--own-token", "tok-a", "--own-id", "1", "--foreign-id", "2"],
  },
  "cookie-flags": {
    server: join(PKG, "fixtures", "cookie-flags", "server.mjs"),
    extra: [],
  },
};

function ssrfCase(mode) {
  // ssrf ships a self-contained demo harness (starts its own mock, exits with
  // the check's code, prints the check's JSON).
  const r = spawnSync(node, [join(PKG, "fixtures", "ssrf", "demo.mjs"), mode],
                      { cwd: PKG, encoding: "utf8" });
  const line = (r.stdout || "").trim().split("\n").filter(Boolean).pop();
  let obj = null; try { obj = JSON.parse(line); } catch { /* */ }
  return { exit: r.status, obj };
}

// good/bad invocations per check (the server-based ones are handled specially).
const stateGoodBad = (name) => ({
  good: ["--state-fixture", `fixtures/${name}/good/state.json`],
  bad:  ["--state-fixture", `fixtures/${name}/bad/state.json`],
});
const targetGoodBad = (name) => ({
  good: ["--target", `fixtures/${name}/good`],
  bad:  ["--target", `fixtures/${name}/bad`],
});
const FILE_CASES = {
  rls:        targetGoodBad("rls"),
  revoke:     targetGoodBad("revoke"),
  "secret-leak": targetGoodBad("secret-leak"),
  "dns-auth": { good: ["--resolver-fixture", "fixtures/dns-auth/good/resolver.json", "--domain", "tessera-project.dev"],
                bad:  ["--resolver-fixture", "fixtures/dns-auth/bad/resolver.json", "--domain", "tessera-project.dev"] },
  "matrix-freshness": { good: ["--source", "fixtures/matrix-freshness/good/index.json"],
                        bad:  ["--source", "fixtures/matrix-freshness/bad/index.json"] },
  // app:static — read the fixture repo via --target, exactly like the repo checks.
  "security-headers": targetGoodBad("security-headers"),
  "dependency-audit": targetGoodBad("dependency-audit"),
  "app-logging":      targetGoodBad("app-logging"),
  // infra logging/detection config — validate a state document (dns-auth pattern).
  "supabase-logging":     stateGoodBad("supabase-logging"),
  "gh-secret-scanning":   stateGoodBad("gh-secret-scanning"),
  "device-signin-alerts": stateGoodBad("device-signin-alerts"),
  "vercel-observability": stateGoodBad("vercel-observability"),
  // alert-route — driven by mock notifiers (the live stub is the unknown path,
  // asserted separately below).
  "alert-route": { good: ["--notifier", "fixtures/alert-route/good-notifier.mjs"],
                   bad:  ["--notifier", "fixtures/alert-route/bad-notifier.mjs"] },
};

const ALL = [
  // repo
  "rls", "revoke", "secret-leak",
  // app:static
  "security-headers", "dependency-audit", "app-logging",
  // app:dynamic
  "access-probe", "cookie-flags",
  // infra
  "ssrf", "webhook-auth", "dns-auth",
  "supabase-logging", "gh-secret-scanning", "device-signin-alerts", "vercel-observability",
  "alert-route", "matrix-freshness",
];

function ok(b) { return b ? "ok " : "XX "; }

const rows = [];
let allPass = true;

for (const control of ALL) {
  const st = selfTest(control);

  let good, bad;
  if (control === "ssrf") { good = ssrfCase("good"); bad = ssrfCase("bad"); }
  else if (control === "webhook-auth") { good = await webhookCase("good"); bad = await webhookCase("bad"); }
  else if (SERVER_CASES[control]) {
    const { server, extra } = SERVER_CASES[control];
    good = await serverCase(control, server, "good", extra);
    bad = await serverCase(control, server, "bad", extra);
  }
  else { good = check(control, FILE_CASES[control].good); bad = check(control, FILE_CASES[control].bad); }

  const goodPass = good.obj?.status === "pass" && good.exit === 0;
  const badFail = bad.obj?.status === "fail" && bad.exit === 1;
  const ncInjected = bad.obj?.negative_control?.injected === true;
  const earned = st.ok && goodPass && badFail && ncInjected;
  if (!earned) allPass = false;

  rows.push({ control, selfTest: st.ok, goodPass, badFail, ncInjected, earned,
              attack: (good.obj?.attack || []).map((a) => a.id).join(",") });
}

process.stderr.write("\n=== demonstration: every check watched to fail its bad fixture ===\n\n");
process.stderr.write("  check              self  good=PASS  bad=FAIL  bad-nc-injected  ATT&CK\n");
for (const r of rows) {
  process.stderr.write(`  ${r.control.padEnd(18)} ${ok(r.selfTest)}  ${ok(r.goodPass)}      ` +
                       `${ok(r.badFail)}     ${ok(r.ncInjected)}          ${r.attack}\n`);
}

// E-round: the wrapper layer (run.mjs) must not introduce a false pass.
process.stderr.write("\n=== E-round: real repo-surface dispatch against /studio ===\n");
const eround = spawnSync(node, [join(PKG, "run.mjs"), "--surface", "repo", "--target", "/studio"],
                         { cwd: PKG, encoding: "utf8" });
process.stderr.write(eround.stderr || "");
const erObj = JSON.parse(eround.stdout);
const erOk = erObj.counts.fail === 0 && erObj.counts.unknown === 0 && eround.status === 0;
if (!erOk) allPass = false;

// Stub assertion: the alert route, run against the REAL (stubbed) notifier, must
// report `unknown` — an honest unverified, NEVER a false pass — until the n8n
// workflow is wired behind notify/. A green here would be the exact lie the
// package forbids (handoff §3/§6).
process.stderr.write("\n=== alert-route against the live (stubbed) channel — must be UNKNOWN ===\n");
const ar = check("alert-route", []); // no --notifier => the real notify/ stub
const arUnknown = ar.obj?.status === "unknown" && ar.exit === 2;
process.stderr.write(`  alert-route live: status=${ar.obj?.status} exit=${ar.exit} ` +
  `(expected unknown/2) — ${ar.obj?.message || ""}\n`);
if (!arUnknown) allPass = false;

process.stderr.write(`\n${allPass ? "DEMONSTRATION PASSED" : "DEMONSTRATION FAILED"}: ` +
  `${rows.filter((r) => r.earned).length}/${rows.length} checks earned their verdicts; ` +
  `E-round repo dispatch ${erOk ? "clean" : "REGRESSED"}.\n\n`);

process.exit(allPass ? 0 : 1);
