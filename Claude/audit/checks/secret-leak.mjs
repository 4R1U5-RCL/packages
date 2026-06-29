#!/usr/bin/env node
// secret-leak.mjs — CONTROL: secret-leak   SURFACE: repo
//
// Asserts two things about a repo root:
//   1. No known-shape secret (API key / JWT / private key) appears in a TRACKED
//      source file (the manifest globs, minus node_modules/.git/lockfiles and
//      the audit package's own fixtures).
//   2. `.env` is gitignored — so the real secrets, which live in .env, never
//      get committed. A committed/unignored .env is the leak we can't see by
//      scanning content alone, so we check the ignore rule directly.
//
// Mirrors rls.mjs (THE reference): read the FIXED manifest, SELF-GUARD FIRST via
// the SAME detector path used on the real target, then judge the target. A pass
// is only emitted when the negative control actually fired; _common.mjs
// structurally downgrades any unwatched pass to "unknown".
//
// Run:  node secret-leak.mjs --target /path/to/repo
//       node secret-leak.mjs --self-test
//
// Node 22 built-ins only. Zero npm deps.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { gatherFiles } from "./_sqlutil.mjs";
import { Result, emitResult } from "./_common.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const MANIFEST = join(PKG, "manifests", "secret-leak.json");
const FIX_GOOD = join(PKG, "fixtures", "secret-leak", "good");
const FIX_BAD = join(PKG, "fixtures", "secret-leak", "bad");

const CONTROL = "secret-leak";
const SURFACE = "repo";

function loadManifest() {
  const m = JSON.parse(readFileSync(MANIFEST, "utf8"));
  return {
    globs: m.globs,
    exclude: m.exclude ?? [],
    patterns: (m.patterns ?? []).map((p) => ({ name: p.name, re: new RegExp(p.regex) })),
    accepts: (m.gitignore && m.gitignore.accepts) ?? [".env", "*.env", ".env.*", ".env*"],
  };
}

// Minimal glob -> RegExp (same dialect as _sqlutil's internal walker, kept local
// because that one isn't exported). Used only for the EXCLUDE list.
function globToRegExp(pattern) {
  let re = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  re = re.replace(/\*\*\//g, "(?:.*/)?");
  re = re.replace(/\*\*/g, ".*");
  re = re.replace(/\*/g, "[^/]*");
  return new RegExp("^" + re + "$");
}

function excluder(globs) {
  const ms = globs.map(globToRegExp);
  return (rel) => ms.some((m) => m.test(rel));
}

// SECRET SCAN — walk the manifest globs under `root`, drop excluded paths, then
// test every line against every known key shape. Returns structured findings so
// a finding attributes back to file:line:pattern.
function scanSecrets(root, globs, exclude, patterns) {
  const isExcluded = excluder(exclude);
  const files = gatherFiles(root, globs).filter((f) => !isExcluded(relative(root, f)));
  const findings = [];
  for (const f of files) {
    let text;
    try { text = readFileSync(f, "utf8"); } catch { continue; }
    const rel = relative(root, f);
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      for (const p of patterns) {
        if (p.re.test(lines[i])) findings.push({ file: rel, pattern: p.name, line: i + 1 });
      }
    }
  }
  return { findings, nFiles: files.length };
}

// GITIGNORE CHECK — confirm `.env` is ignored. The real secrets live in .env;
// the only thing keeping them out of the repo is this rule, so verify it
// directly rather than trusting the (uncommitted) file's absence.
function envIgnored(root, accepts) {
  let text;
  try { text = readFileSync(join(root, ".gitignore"), "utf8"); }
  catch { return { ignored: false, reason: "no .gitignore at target root" }; }
  const acceptSet = new Set(accepts);
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    line = line.replace(/^\/+/, "").replace(/\/+$/, ""); // strip leading/trailing slashes
    if (acceptSet.has(line)) return { ignored: true, reason: `.gitignore ignores "${line}"` };
  }
  return { ignored: false, reason: ".gitignore present but does not ignore .env (.env/*.env/.env.*)" };
}

// Self-guard runs the SAME scanSecrets() path used on real targets against the
// bundled fixtures (laid out as repo roots so the globs match). The bad fixture
// MUST trip a pattern (negative control fires) and the good fixture MUST be
// clean (guards against a scanner that flags everything). ok=false => broken.
function selfGuard() {
  const { globs, exclude, patterns } = loadManifest();
  let bad, good;
  try {
    bad = scanSecrets(FIX_BAD, globs, exclude, patterns);
    good = scanSecrets(FIX_GOOD, globs, exclude, patterns);
  } catch (e) {
    return { ok: false, injected: false, fired: false, note: `fixtures unreadable: ${e.message}` };
  }
  // injected: bad fixture was actually scanned (>=1 file) AND a known secret is
  // provably present in it (not an empty/unmatched scan).
  const injected = bad.nFiles >= 1 && bad.findings.length >= 1;
  const fired = bad.findings.length >= 1; // our detector flagged it
  const clean = good.nFiles >= 1 && good.findings.length === 0; // good scanned & clean
  if (!injected) {
    return { ok: false, injected, fired,
      note: `self-guard FAILED: bad fixture scanned ${bad.nFiles} file(s), ` +
            `${bad.findings.length} finding(s) — negative control could not be injected ` +
            `(expected a known secret in fixtures/secret-leak/bad)` };
  }
  if (!clean) {
    return { ok: false, injected, fired,
      note: `self-guard FAILED: good fixture scanned ${good.nFiles} file(s) with ` +
            `${good.findings.length} finding(s) — scanner false-positives or did not ` +
            `parse, cannot trust it` };
  }
  const hit = bad.findings[0];
  return { ok: true, injected, fired,
    note: `self-guard OK: bad fixture flagged ${hit.pattern} at ${hit.file}:${hit.line}, ` +
          `good fixture clean (${good.nFiles} files, 0 findings)` };
}

function run(target) {
  const r = new Result(CONTROL, SURFACE);
  const sg = selfGuard();
  r.negativeControl({ injected: sg.injected, fired: sg.fired, note: sg.note });
  if (!sg.ok) {
    return r.set("unknown", { evidence: sg.note,
      message: "secret-leak check self-guard failed — verdict not trustworthy" });
  }

  const { globs, exclude, patterns, accepts } = loadManifest();
  const scan = scanSecrets(target, globs, exclude, patterns);
  const git = envIgnored(target, accepts);

  if (scan.nFiles === 0) {
    return r.set("unknown", {
      evidence: `manifest globs matched 0 source file(s) under ${target} — nothing to ` +
                `scan; check target path/globs. (.gitignore check: ${git.reason})`,
      message: "secret-leak: no source files found at target (unverifiable)" });
  }

  const problems = [];
  if (scan.findings.length) {
    const listed = scan.findings.map((f) => `${f.file}:${f.line}[${f.pattern}]`).join("; ");
    problems.push(`${scan.findings.length} secret pattern hit(s): ${listed}`);
  }
  if (!git.ignored) {
    problems.push(`.env not gitignored — ${git.reason}`);
  }
  if (problems.length) {
    return r.set("fail", {
      evidence: `scanned ${scan.nFiles} file(s); ${problems.join(" | ")}`,
      message: `secret-leak: ${scan.findings.length} committed secret(s)` +
               `${git.ignored ? "" : ", .env not gitignored"}` });
  }
  return r.set("pass", {
    evidence: `scanned ${scan.nFiles} tracked source file(s), 0 secret patterns; ` +
              `${git.reason}; ${sg.note}`,
    message: "secret-leak: no committed secrets and .env is gitignored" });
}

function main(argv) {
  const target = (() => {
    const i = argv.indexOf("--target");
    return i >= 0 ? argv[i + 1] : process.cwd();
  })();
  if (argv.includes("--self-test")) {
    const sg = selfGuard();
    console.log(JSON.stringify({ control: CONTROL, ok: sg.ok, self_guard_ok: sg.ok,
      injected: sg.injected, fired: sg.fired, note: sg.note }));
    return sg.ok ? 0 : 2;
  }
  return emitResult(run(target));
}

process.exit(main(process.argv.slice(2)));
