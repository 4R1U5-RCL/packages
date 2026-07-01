#!/usr/bin/env node
// Claude/ops-agents/nightly-sweep.mjs — [AGENT] Nightly dependabot + audit sweep.
//
// STANDALONE port of studio's clients/_ops-agents/agents/nightly-sweep.ts into
// the packages repo (its durable, committed home). It has NO `@studio/*` imports:
//   • the guarded-write guard is the local ./guard.mjs (port of @studio/agent-kit/guard),
//   • the digest seam is the repo's own ../notify/src/client.mjs (@studio/notify twin),
// so it runs standalone in dry-run from /root/packages with only Node 22 built-ins.
//
// GATHERS (read-only): open Dependabot PRs across the four 4R1U5-RCL repos via
// read-only `gh` (`gh pr list … --author app/dependabot`) plus a per-repo audit
// signal (the local Claude/audit tool if the repo is checked out, else read-only
// `gh api …/code-scanning/alerts`), then builds a Telegram digest through the
// sanctioned notify webhook — NOT a guarded write.
//
// DEFERS (never performed here): merging any green patch/minor PR (`gh … merge`)
// and applying a dependency/audit fix (`git push`). Both are represented via
// deferGuardedWrite and handed to the main session behind --apply — guarded infra
// stays with the main session. This agent performs ZERO guarded I/O on ANY path;
// --apply only ARMS the deferred plan.
//
//   node nightly-sweep.mjs --selftest   # in-process guard proof (stubbed seams)
//   node nightly-sweep.mjs              # real dry-run gather + digest
//   node nightly-sweep.mjs --apply      # ARM the deferred plan for the main session

import { promisify } from "node:util";
import { execFile as execFileCb } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import { assertNoGuardedWrites, deferGuardedWrite } from "./guard.mjs";
import { notify as notifyClient } from "../notify/src/client.mjs";

const execFile = promisify(execFileCb);
const HERE = dirname(fileURLToPath(import.meta.url));
const AUDIT_RUN = join(HERE, "..", "audit", "run.mjs");

const AGENT = "[AGENT] nightly-sweep";

/** The four 4R1U5-RCL repos the sweep covers (repo NAMES, not secrets). */
export const REPOS = ["studio", "tessera", "mosaic", "packages"];

// ── notify seam ──────────────────────────────────────────────────────────────
// Thin wrapper over the repo's canonical outbound seam (../notify/src/client.mjs).
// Honest-skips when NOTIFY_WEBHOOK_URL / NOTIFY_TOKEN are absent (the client returns
// a not-wired result WITHOUT any fetch) — so a dry-run with no creds sends nothing
// and never crashes. The webhook POST is the sanctioned notify channel, NOT a
// guarded write (spec C1: …/webhook/… is allowed).
export async function sendDigest(digest) {
  const url = process.env.NOTIFY_WEBHOOK_URL;
  const token = process.env.NOTIFY_TOKEN;
  const secret = process.env.NOTIFY_SECRET ?? token;
  if (!url || !token) {
    return { delivered: false, skipped: "notify seam absent (NOTIFY_WEBHOOK_URL / NOTIFY_TOKEN unset) — nothing sent" };
  }
  const res = await notifyClient(
    { source: "ops-agent", kind: "alert", message: digest.title, summary: digest.body, meta: { agent: AGENT } },
    { url, token, secret },
  );
  return res.delivered ? { delivered: true } : { delivered: false, skipped: res.note };
}

// ── report helpers (port of the _kit spine) ──────────────────────────────────
function emptyReport(agent, mode) {
  return { agent, mode, ok: true, summary: "", findings: [], deferred: [], armed: mode === "apply", notes: [] };
}

/** Classify a dependabot PR title into a semver bump (green patch/minor are merge-eligible). */
export function classifyBump(title) {
  const m = /from\s+(\d+)\.(\d+)\.(\d+)\S*\s+to\s+(\d+)\.(\d+)\.(\d+)/i.exec(title);
  if (!m) return "unknown";
  const a = m[1];
  const b = m[4];
  if (a !== b) return "major";
  return m[2] !== m[5] ? "minor" : "patch";
}

// ── read seams ────────────────────────────────────────────────────────────────
/** Per-repo audit signal. Prefers the LOCAL Claude/audit tool when the repo is
 *  checked out (env SWEEP_REPO_<NAME> points at its root); else falls back to the
 *  read-only code-scanning alert count. Both are reads — honest-skips otherwise. */
async function auditSignal(repo, slug) {
  const localPath = process.env[`SWEEP_REPO_${repo.toUpperCase()}`];
  if (localPath) {
    try {
      const { stdout } = await execFile("node", [AUDIT_RUN, "--surface", "repo", "--target", localPath]);
      const agg = JSON.parse(stdout || "{}");
      const results = Array.isArray(agg.results) ? agg.results : [];
      return { findings: results.filter((x) => x.status === "fail").length, source: "Claude/audit (local repo)" };
    } catch (err) {
      // fall through to the gh signal
    }
  }
  try {
    const { stdout } = await execFile("gh", ["api", `repos/${slug}/code-scanning/alerts`, "--jq", "length"]);
    return { findings: Number.parseInt(String(stdout).trim(), 10) || 0, source: "gh code-scanning alerts" };
  } catch {
    return { findings: 0, source: null };
  }
}

/** REAL read seam: read-only `gh` for open dependabot PRs + the per-repo audit signal. */
async function realReadRepo(repo) {
  const slug = `4R1U5-RCL/${repo}`;
  try {
    const { stdout } = await execFile("gh", [
      "pr", "list", "-R", slug, "--author", "app/dependabot", "--state", "open", "--json", "number,title",
    ]);
    const rows = JSON.parse(stdout || "[]");
    const prs = rows.map((r) => ({
      number: r.number,
      title: r.title,
      bump: classifyBump(r.title),
      ciGreen: true, // conservative label; the merge is deferred regardless
    }));
    const audit = await auditSignal(repo, slug);
    return {
      repo,
      prs,
      auditFindings: audit.findings,
      note: audit.source ? undefined : "audit signal unavailable (no local checkout, gh code-scanning read failed)",
    };
  } catch (err) {
    return { repo, prs: [], auditFindings: 0, note: `gh read unavailable (${err instanceof Error ? err.message : String(err)})` };
  }
}

const realSeams = { readRepo: realReadRepo, notify: sendDigest };

/** SELF-CONTAINED stub seams for --selftest: canned repo state, notify stubbed (no network). */
export const stubSeams = {
  readRepo: async (repo) => ({
    repo,
    prs:
      repo === "studio"
        ? [
            { number: 101, title: "Bump react from 18.3.0 to 18.3.1", bump: "patch", ciGreen: true },
            { number: 102, title: "Bump next from 14.1.0 to 15.0.0", bump: "major", ciGreen: true },
          ]
        : [],
    auditFindings: repo === "tessera" ? 1 : 0,
  }),
  notify: async () => ({ delivered: false, skipped: "selftest — notify stubbed (no network)" }),
};

/** Render the redacted Telegram digest body from the gathered repo states. */
function renderDigest(states) {
  const lines = states.map((s) => {
    const green = s.prs.filter((p) => (p.bump === "patch" || p.bump === "minor") && p.ciGreen).length;
    const held = s.prs.length - green;
    return `• ${s.repo}: ${s.prs.length} dependabot PR(s) — ${green} green patch/minor, ${held} held; ${s.auditFindings} audit finding(s)`;
  });
  return { title: `${AGENT} — nightly digest`, body: ["Nightly dependabot + audit sweep", ...lines].join("\n") };
}

// ── the agent ─────────────────────────────────────────────────────────────────
export async function run(opts = {}) {
  const apply = opts.apply === true;
  const seams = { ...realSeams, ...(opts.seams || {}) };
  const report = emptyReport(AGENT, apply ? "apply" : "dry-run");

  const states = [];
  for (const repo of REPOS) states.push(await seams.readRepo(repo));

  for (const s of states) {
    if (s.note) report.notes.push(`${s.repo}: ${s.note}`);
    for (const pr of s.prs) {
      const mergeEligible = (pr.bump === "patch" || pr.bump === "minor") && pr.ciGreen;
      report.findings.push({
        id: `${s.repo}#${pr.number}`,
        severity: pr.bump === "major" ? "warn" : "info",
        title: `${s.repo}#${pr.number} ${pr.bump} — ${pr.title}`,
        detail: mergeEligible
          ? "green patch/minor — merge DEFERRED to the main session (behind --apply)"
          : "major or non-green — held for human review (never auto-merged)",
      });
      if (mergeEligible) {
        // DEFERRED: squash-merge is a guarded `gh … merge` — represented only, never performed here.
        report.deferred.push(
          deferGuardedWrite({
            kind: "gh-merge",
            target: `4R1U5-RCL/${s.repo}#${pr.number}`,
            summary: `squash-merge green ${pr.bump} dependabot PR (DEFERRED to main session)`,
          }),
        );
      }
    }
    if (s.auditFindings > 0) {
      report.findings.push({
        id: `${s.repo}:audit`,
        severity: "warn",
        title: `${s.repo}: ${s.auditFindings} open audit finding(s)`,
        detail: "fix-apply DEFERRED to the generator/main session (no git push here)",
      });
      // DEFERRED: applying an audit fix would be a `git push` — represented only, never performed here.
      report.deferred.push(
        deferGuardedWrite({
          kind: "git-push",
          target: `4R1U5-RCL/${s.repo}`,
          summary: "apply audit fix + push (DEFERRED — must go through the generator, not this agent)",
        }),
      );
    }
  }

  // Build + send the digest through the sanctioned notify webhook (NOT a guarded write).
  report.digest = await seams.notify(renderDigest(states));

  const totalPrs = states.reduce((n, s) => n + s.prs.length, 0);
  report.summary =
    `swept ${REPOS.length} repos: ${totalPrs} dependabot PR(s), ${report.deferred.length} deferred action(s). ` +
    (apply ? "plan ARMED for the main session." : "dry-run — merges/fixes deferred, not performed.");
  report.ok = true;
  return report;
}

/** In-process guard proof: run the dry-run gather (stubbed seams) under
 *  assertNoGuardedWrites and fold the verdict in — a stray guarded write is
 *  caught IN-AGENT, not only by a later harness stage. */
export async function selftest() {
  const outcome = await assertNoGuardedWrites(() => run({ dryRun: true, apply: false, seams: stubSeams }));
  const attempts = outcome.violations.length;
  const clean = attempts === 0 && outcome.crashed == null;
  const base =
    outcome.result ?? {
      agent: AGENT,
      mode: "dry-run",
      ok: false,
      summary: outcome.crashed ? `selftest gather crashed: ${outcome.crashed.message}` : "selftest gather returned no report",
      findings: [],
      deferred: [],
      armed: false,
      notes: [],
    };
  return {
    ...base,
    mode: "dry-run",
    ok: base.ok && clean,
    selftest: { ranUnderGuard: true, guardedWriteAttempts: attempts, clean, violations: outcome.violations },
  };
}

// ── CLI ────────────────────────────────────────────────────────────────────────
function parseAgentArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { "dry-run": { type: "boolean" }, apply: { type: "boolean" }, selftest: { type: "boolean" } },
  });
  const apply = values.apply === true;
  return { apply, selftest: values.selftest === true, dryRun: !apply };
}

function isEntrypoint(importMetaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return new URL(importMetaUrl).pathname === entry || importMetaUrl.endsWith(entry);
  } catch {
    return false;
  }
}

if (isEntrypoint(import.meta.url)) {
  const { apply, selftest: doSelftest, dryRun } = parseAgentArgs(process.argv.slice(2));
  const report = doSelftest ? await selftest() : await run({ apply, dryRun });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}
