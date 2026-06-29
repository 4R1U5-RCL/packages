// _fsutil.mjs — shared filesystem helpers for the hygiene controls (cleanup, backup).
//
// Parsing/IO infrastructure, NOT control logic: each control still decides what
// counts as pass/fail. This module only walks a tree, classifies a path against
// the cleanup manifest rules, and builds/verifies a .tar.gz so cleanup.mjs and
// backup.mjs don't each reinvent fragile glob + archive code. Inside the package
// (self-containment holds). No npm dependencies — Node v22 built-ins only.
//
// ARCHIVE TOOLING — the deliberate choice. node:zlib gives gzip but NOT the tar
// container format, so a from-scratch backup would mean hand-rolling a tar writer
// (header blocks, checksums, padding) — extra surface to get wrong in a tool whose
// whole job is to be trustworthy. The host has GNU tar 1.34, so we SPAWN system
// `tar` via node:child_process for create/list/extract, and use node:crypto for
// the sha256. Simpler, and it matches what an operator would run by hand.

import { readFileSync, readdirSync, mkdirSync, renameSync, existsSync, statSync, cpSync, writeFileSync, rmSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";

// spawnSync defaults to a 1 MB stdout/stderr buffer; a real ~/.claude tree blows
// past that (tar listings, large drift reports) and silently truncates → garbled
// output and a false `unknown`. Give every spawn here generous headroom.
const MAXBUF = 64 * 1024 * 1024;

// ── globbing ────────────────────────────────────────────────────────────────
// Minimal glob → RegExp. For cleanup basenames `*` matches anything (no slashes
// in a basename anyway). For tar-exclude paths `*` matches ACROSS slashes, to
// mirror GNU tar's default wildcard behaviour.
export function basenameGlob(pattern) {
  let re = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  re = re.replace(/\*/g, ".*");
  return new RegExp("^" + re + "$");
}

export function matchAnyGlob(name, globs) {
  return globs.some((g) => basenameGlob(g).test(name));
}

// ── the shared exclude set ──────────────────────────────────────────────────
// ONE source of truth (manifests/_exclude.json), read by both controls and
// applied identically to the walk AND to tar. mergeExclude de-dupes the shared
// set with a control's own manifest excludes, preserving order.
export function sharedExclude(pkgDir) {
  try {
    const j = JSON.parse(readFileSync(join(pkgDir, "manifests", "_exclude.json"), "utf8"));
    return Array.isArray(j.shared_exclude) ? j.shared_exclude : [];
  } catch { return []; }
}

export function mergeExclude(...lists) {
  const seen = new Set();
  const out = [];
  for (const l of lists) for (const x of l || []) {
    if (!seen.has(x)) { seen.add(x); out.push(x); }
  }
  return out;
}

// ── profiles ────────────────────────────────────────────────────────────────
// A profile (profiles/<name>.json) declares the cleanup semantics + backup policy
// for one ENVIRONMENT (claude / codebase / llm-artifacts). The control scripts
// dispatch on profile.cleanup.mode and profile.backup.engine. Default is `claude`
// (full back-compat with v0.2.1).
export function loadProfile(pkgDir, name) {
  const file = join(pkgDir, "profiles", `${name}.json`);
  return JSON.parse(readFileSync(file, "utf8"));
}

// Resolve the exclude set for ONE operation block (cleanup or backup of a
// profile). Honours its `use_shared_exclude` flag — claude/backup opt INTO the
// shared vendored/cache set; llm-artifacts opts OUT (it must look inside `cache`
// to find a misplaced valuable artifact). Then merges the op's own `exclude`.
export function resolveExclude(pkgDir, opBlock) {
  const shared = opBlock?.use_shared_exclude ? sharedExclude(pkgDir) : [];
  return mergeExclude(shared, opBlock?.exclude || []);
}

// ── git (codebase profile) ────────────────────────────────────────────────────
// Ignore resolution is DELEGATED to git rather than reimplemented — git is the
// authority on what .gitignore excludes. A non-repo target is reported `unknown`
// by the caller (never a false pass).
export function isGitRepo(target) {
  const r = spawnSync("git", ["-C", target, "rev-parse", "--is-inside-work-tree"],
                      { encoding: "utf8", maxBuffer: MAXBUF });
  return !r.error && r.status === 0 && (r.stdout || "").trim() === "true";
}

// Run `git -C target ls-files -z <args>` and return POSIX rel paths (sorted,
// deduped). NUL-delimited (-z) so paths with spaces / unicode / newlines come
// through EXACTLY and unquoted — they then match walkTree's rel paths and tar's
// --null -T list without a quoting round-trip.
export function gitLsFiles(target, args) {
  const r = spawnSync("git", ["-C", target, "ls-files", "-z", ...args],
                      { encoding: "utf8", maxBuffer: MAXBUF });
  if (r.error || r.status !== 0) {
    return { ok: false, files: [], error: (r.stderr || r.error?.message || "").trim() };
  }
  const files = [...new Set((r.stdout || "").split("\0").filter(Boolean))].sort();
  return { ok: true, files };
}

// The authoritative backup set for a git repo: tracked + untracked-but-not-ignored
// (exactly what git would carry, minus what .gitignore excludes). git lists a
// NESTED repo / worktree it won't descend into as an opaque DIRECTORY entry (a
// trailing-slash path) — those are separate repositories, not this repo's files,
// so they are dropped (and counted) rather than folded into the parent's backup.
export function gitBackupSet(target) {
  const r = gitLsFiles(target, ["--cached", "--others", "--exclude-standard"]);
  if (!r.ok) return r;
  const files = r.files.filter((f) => !f.endsWith("/"));
  return { ok: true, files, nestedSkipped: r.files.length - files.length };
}

// Build outPath = a .tar.gz of an EXPLICIT relative-file list under srcDir (used
// by the codebase backup so the archived set is precisely git's file list — no
// exclude-glob round-trip, so expected == archived by construction). Returns
// { ok, error }. An empty list is an error (nothing to archive).
export function createArchiveFromList(srcDir, outPath, relFiles) {
  if (!relFiles || relFiles.length === 0) return { ok: false, error: "empty file list" };
  // NUL-delimited list (--null) so any path (spaces/unicode/newlines) is exact.
  const listFile = join(mkTmpDir("hygiene-list-"), "files.nul");
  writeFileSync(listFile, relFiles.join("\0") + "\0");
  const r = spawnSync("tar", ["-czf", outPath, "-C", srcDir, "--no-recursion", "--null", "-T", listFile],
                      { encoding: "utf8", maxBuffer: MAXBUF });
  try { rmSync(join(listFile, ".."), { recursive: true, force: true }); } catch { /* */ }
  if (r.error) return { ok: false, error: r.error.message };
  if (r.status !== 0) return { ok: false, error: (r.stderr || "").trim() || `tar exit ${r.status}` };
  return { ok: true };
}

// Does any path component of `rel` match one of `names` (e.g. is the file inside a
// `cache`/`blobs` directory)? Used by the llm-artifacts placement detector.
export function pathHasComponent(rel, names) {
  const set = new Set(names);
  return rel.split("/").slice(0, -1).some((c) => set.has(c));
}

// git init / add — used ONLY by the codebase self-guard, which stages a throwaway
// copy of a fixture into a real git repo so the SAME git-authoritative detector
// path that judges a real repo is exercised offline. `add` stages without a
// commit (no git identity needed); `git ls-files` then reports staged files as
// tracked. files === "-A" stages everything not gitignored.
export function gitInit(dir) {
  const r = spawnSync("git", ["-C", dir, "init", "-q"], { encoding: "utf8", maxBuffer: MAXBUF });
  return !r.error && r.status === 0;
}

export function gitAdd(dir, files) {
  const args = files === "-A" ? ["-C", dir, "add", "-A"] : ["-C", dir, "add", "--", ...files];
  const r = spawnSync("git", args, { encoding: "utf8", maxBuffer: MAXBUF });
  return !r.error && r.status === 0;
}

// Stage a codebase fixture into a throwaway git repo. The fixture ships its ignore
// file as `gitignore` (no dot) so the package repo's own git does not ignore the
// fixture's deliberately-ignored files (app.log, dist/out.js) — they MUST be present
// in a fresh clone for the "don't flag correctly-ignored junk" guard to mean
// anything. Here we copy the fixture, rename gitignore -> .gitignore, and git init,
// so the SAME git-authoritative detector path runs offline. Returns the staging path.
export function stageGitFixture(srcDir, prefix) {
  const dir = stageCopy(srcDir, prefix);
  const gi = join(dir, "gitignore");
  if (existsSync(gi)) renameSync(gi, join(dir, ".gitignore"));
  gitInit(dir);
  return dir;
}

// ── tree walk ─────────────────────────────────────────────────────────────────
// Returns entries { rel, full } with POSIX-style `rel` (forward slashes, no
// leading "./"). Counts regular files AND symlinks — tar archives symlinks as
// their own members, so the walk must too or the expected set and the archive
// disagree. Applies the exclude set at DIRECTORY granularity (an excluded dir is
// not descended into), exactly mirroring how GNU tar skips an excluded subtree,
// so the walk and the archive see the identical set.
export function walkTree(root, { exclude = [], skipGit = true } = {}) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const full = join(dir, e.name);
      const rel = relative(root, full).split(sep).join("/");
      if (skipGit && e.name === ".git") continue;       // any-depth .git, like tar
      if (isExcluded(rel, exclude)) continue;
      if (e.isDirectory()) walk(full);
      else out.push({ rel, full });                     // files + symlinks
    }
  };
  walk(root);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

// Mirror GNU tar's DEFAULT (unanchored) `--exclude=PATTERN` semantics for the
// pattern shapes we use, so a single exclude set drives both the walk and tar:
//   - bare name (no slash, no `*`)  e.g. node_modules, .git, plugins, cache
//        → matches if ANY path component equals it (the dir and its whole
//          subtree at any depth — tar skips such a directory wherever it sits).
//   - basename glob (no slash, has `*`) e.g. *.tar.gz, .env.*
//        → matches against the member's final component, at any depth.
//   - path with a slash  e.g. data/backups
//        → matches that path at the root or nested (unanchored), incl. subtree.
// Matching at directory granularity in walkTree means an excluded dir is never
// descended, exactly as tar prunes an excluded subtree.
export function isExcluded(rel, patterns) {
  if (!patterns || patterns.length === 0) return false;
  const comps = rel.split("/");
  const base = comps[comps.length - 1];
  for (const raw of patterns) {
    const p = String(raw).replace(/^\.\//, "").replace(/\/$/, "");
    if (!p) continue;
    if (p.includes("/")) {
      if (rel === p || rel.startsWith(p + "/") ||
          rel.endsWith("/" + p) || rel.includes("/" + p + "/")) return true;
    } else if (p.includes("*")) {
      if (basenameGlob(p).test(base)) return true;
    } else {
      if (comps.includes(p)) return true;
    }
  }
  return false;
}

// ── cleanup classification ──────────────────────────────────────────────────
// Detect skill/command frontmatter: a leading `---` block carrying a name: or
// description: key (the shape of a slash-command file).
export function hasSkillFrontmatter(content) {
  if (!content.startsWith("---")) return false;
  const end = content.indexOf("\n---", 3);
  if (end < 0) return false;
  const block = content.slice(0, end);
  return /\n\s*(name|description)\s*:/.test(block);
}

function dirOf(rel) {
  const i = rel.lastIndexOf("/");
  return i < 0 ? "" : rel.slice(0, i);
}

function baseOf(rel) {
  const i = rel.lastIndexOf("/");
  return i < 0 ? rel : rel.slice(i + 1);
}

// Classify one file against the ordered cleanup rules. Returns the first rule
// whose globs match the basename (rules are ordered specific → generic). The
// `requires_frontmatter` rule (the catch-all *.md → commands/) only matches when
// the file actually carries skill frontmatter, so a plain note never gets swept.
//   { matched, rule, dest, inPlace, stray, from, to }
export function classifyPath(entry, rules) {
  const base = baseOf(entry.rel);
  const dir = dirOf(entry.rel);
  for (const rule of rules) {
    if (!matchAnyGlob(base, rule.globs)) continue;
    if (rule.requires_frontmatter) {
      let content = "";
      try { content = readFileSync(entry.full, "utf8"); } catch { continue; }
      if (!hasSkillFrontmatter(content)) continue;
    }
    const destDir = String(rule.dest).replace(/\/$/, "");
    const inPlace = dir === destDir || dir.startsWith(destDir + "/");
    return {
      matched: true,
      rule: rule.id,
      dest: destDir,
      inPlace,
      stray: !inPlace,
      from: entry.rel,
      to: destDir ? destDir + "/" + base : base,
    };
  }
  return { matched: false };
}

// Scan a whole tree against the rules. Returns { stray:[], inPlace:[], scanned }.
export function scanTree(root, rules, exclude = []) {
  const stray = [];
  const inPlace = [];
  let scanned = 0;
  for (const entry of walkTree(root, { exclude })) {
    scanned++;
    const c = classifyPath(entry, rules);
    if (!c.matched) continue;
    if (c.stray) stray.push(c);
    else inPlace.push(c);
  }
  return { stray, inPlace, scanned };
}

// ── archive create / verify ───────────────────────────────────────────────────
export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// Build outPath = <srcDir> as a .tar.gz, honouring exclude patterns (also passed
// to tar so the archive and the walk agree). Returns { ok, error }.
export function createArchive(srcDir, outPath, exclude = []) {
  const args = ["-czf", outPath];
  for (const p of exclude) args.push(`--exclude=${p.replace(/^\.\//, "").replace(/\/$/, "")}`);
  args.push("-C", srcDir, ".");
  const r = spawnSync("tar", args, { encoding: "utf8", maxBuffer: MAXBUF });
  if (r.error) return { ok: false, error: r.error.message };
  if (r.status !== 0) return { ok: false, error: (r.stderr || "").trim() || `tar exit ${r.status}` };
  return { ok: true };
}

// List archive members as POSIX rel paths (strip leading "./"). DROP directory
// entries (tar lists them with a trailing "/") so the listing is files+symlinks
// only — the same shape walkTree produces, which is what makes expected == archived.
export function listEntries(archivePath) {
  const r = spawnSync("tar", ["-tzf", archivePath], { encoding: "utf8", maxBuffer: MAXBUF });
  if (r.error || r.status !== 0) return { ok: false, entries: [], error: (r.stderr || r.error?.message || "").trim() };
  const entries = (r.stdout || "").split("\n")
    .filter((s) => s.length > 0 && !s.endsWith("/"))          // drop directory members
    .map((s) => s.replace(/^\.\//, ""))
    .filter((s) => s.length > 0);
  return { ok: true, entries };
}

// Prove the archive is genuinely extractable (not just listable): extract into a
// throwaway temp dir and confirm tar reports success.
export function extractTest(archivePath) {
  const dst = mkTmpDir("hygiene-extract-");
  const r = spawnSync("tar", ["-xzf", archivePath, "-C", dst], { encoding: "utf8", maxBuffer: MAXBUF });
  const ok = !r.error && r.status === 0;
  try { rmSync(dst, { recursive: true, force: true }); } catch { /* best effort */ }
  return { ok, error: ok ? "" : (r.stderr || r.error?.message || "").trim() };
}

// Full verification: archive exists & non-empty, sha256 STABLE across two reads,
// every expectedEntry present (proves the tree was captured, not an empty/partial
// tar), and the archive extracts. `missing` is the set of expected-but-absent
// members — the heart of the negative control: an archive that misses a known
// file is caught here. Returns { ok, sha256, stable, missing, entries, reason }.
export function verifyArchive(archivePath, expectedEntries = []) {
  if (!existsSync(archivePath)) return { ok: false, reason: "archive not created" };
  let size = 0;
  try { size = statSync(archivePath).size; } catch { /* */ }
  if (size === 0) return { ok: false, reason: "archive is empty (0 bytes)" };

  const sha1 = sha256File(archivePath);
  const sha2 = sha256File(archivePath);
  const stable = sha1 === sha2;

  const listed = listEntries(archivePath);
  if (!listed.ok) return { ok: false, sha256: sha1, stable, reason: `unlistable: ${listed.error}` };

  const set = new Set(listed.entries);
  const missing = expectedEntries.filter((e) => !set.has(e));

  const ex = extractTest(archivePath);

  const ok = stable && missing.length === 0 && ex.ok && size > 0;
  return {
    ok, sha256: sha1, stable, missing,
    entries: listed.entries.length, extractable: ex.ok,
    reason: ok ? "verified" :
      !stable ? "sha256 not stable across reads" :
      missing.length ? `archive misses ${missing.length} known file(s): ${missing.slice(0, 3).join(", ")}` :
      !ex.ok ? `not extractable: ${ex.error}` : "unverified",
  };
}

// ── temp helpers ──────────────────────────────────────────────────────────────
export function mkTmpDir(prefix) {
  const dir = join(tmpdir(), prefix + Math.random().toString(36).slice(2, 10));
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Copy a tree into a fresh temp staging dir (so the self-test can inject a
// sentinel without ever touching the real target). Returns the staging path.
export function stageCopy(srcDir, prefix = "hygiene-stage-") {
  const dst = mkTmpDir(prefix);
  cpSync(srcDir, dst, { recursive: true });
  return dst;
}

export const SENTINEL_NAME = ".hygiene-backup-sentinel";

// Drop a known sentinel file into a staging tree; returns its POSIX rel path.
export function injectSentinel(dir, name = SENTINEL_NAME) {
  writeFileSync(join(dir, name), `hygiene sentinel ${Date.now()}\n`);
  return name;
}

// Guarded move used by `cleanup --apply`: refuses to overwrite an existing dest,
// creates the dest dir, renames, then VERIFIES the move (source gone, dest
// present). Returns { ok, refused, reason }.
export function guardedMove(root, from, to) {
  const src = join(root, from);
  const dst = join(root, to);
  if (existsSync(dst)) {
    return { ok: false, refused: true, reason: `dest exists, refusing to overwrite: ${to}` };
  }
  try {
    mkdirSync(dirOfFull(dst), { recursive: true });
    renameSync(src, dst);
  } catch (e) {
    return { ok: false, refused: false, reason: `move failed: ${e.message}` };
  }
  const moved = !existsSync(src) && existsSync(dst);
  if (!moved) return { ok: false, refused: false, reason: `post-move check failed for ${to}` };
  return { ok: true, refused: false, reason: "moved" };
}

function dirOfFull(p) {
  const i = p.lastIndexOf(sep);
  return i < 0 ? "." : p.slice(0, i);
}
