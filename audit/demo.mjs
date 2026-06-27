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

function ssrfCase(mode) {
  // ssrf ships a self-contained demo harness (starts its own mock, exits with
  // the check's code, prints the check's JSON).
  const r = spawnSync(node, [join(PKG, "fixtures", "ssrf", "demo.mjs"), mode],
                      { cwd: PKG, encoding: "utf8" });
  const line = (r.stdout || "").trim().split("\n").filter(Boolean).pop();
  let obj = null; try { obj = JSON.parse(line); } catch { /* */ }
  return { exit: r.status, obj };
}

// good/bad invocations per check (the server-based two are handled specially).
const FILE_CASES = {
  rls:        { good: ["--target", "fixtures/rls/good"], bad: ["--target", "fixtures/rls/bad"] },
  revoke:     { good: ["--target", "fixtures/revoke/good"], bad: ["--target", "fixtures/revoke/bad"] },
  "secret-leak": { good: ["--target", "fixtures/secret-leak/good"], bad: ["--target", "fixtures/secret-leak/bad"] },
  "dns-auth": { good: ["--resolver-fixture", "fixtures/dns-auth/good/resolver.json", "--domain", "tessera-project.dev"],
                bad:  ["--resolver-fixture", "fixtures/dns-auth/bad/resolver.json", "--domain", "tessera-project.dev"] },
  "matrix-freshness": { good: ["--source", "fixtures/matrix-freshness/good/index.json"],
                        bad:  ["--source", "fixtures/matrix-freshness/bad/index.json"] },
};

const ALL = ["rls", "revoke", "secret-leak", "ssrf", "webhook-auth", "dns-auth", "matrix-freshness"];

function ok(b) { return b ? "ok " : "XX "; }

const rows = [];
let allPass = true;

for (const control of ALL) {
  const st = selfTest(control);

  let good, bad;
  if (control === "ssrf") { good = ssrfCase("good"); bad = ssrfCase("bad"); }
  else if (control === "webhook-auth") { good = await webhookCase("good"); bad = await webhookCase("bad"); }
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

process.stderr.write(`\n${allPass ? "DEMONSTRATION PASSED" : "DEMONSTRATION FAILED"}: ` +
  `${rows.filter((r) => r.earned).length}/${rows.length} checks earned their verdicts; ` +
  `E-round repo dispatch ${erOk ? "clean" : "REGRESSED"}.\n\n`);

process.exit(allPass ? 0 : 1);
