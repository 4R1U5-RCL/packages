// _sqlutil.mjs — shared SQL/file helpers for the repo-surface checks (rls, revoke).
//
// Parsing infrastructure, NOT check logic: each check still decides what counts
// as pass/fail. This just turns .sql files into structured facts so rls.mjs and
// revoke.mjs don't each reinvent a fragile regex. Inside the package
// (self-containment holds). No npm dependencies — Node built-ins only.

import { readFileSync, statSync, readdirSync } from "node:fs";
import { join, relative, basename } from "node:path";

// SQL keywords are case-insensitive; real migrations are lowercase but never
// trust casing. Collapse whitespace so multi-line statements match.
export function normalize(sqlText) {
  return sqlText.toLowerCase().replace(/\s+/g, " ");
}

// Minimal recursive glob supporting `**` and `*` segments. Avoids an npm dep.
function walk(dir) {
  let out = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(full));
    else if (e.isFile()) out.push(full);
  }
  return out;
}

function globToRegExp(pattern) {
  // Escape regex metachars except our wildcards, then translate.
  let re = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  re = re.replace(/\*\*\//g, "(?:.*/)?"); // **/ -> any depth incl none
  re = re.replace(/\*\*/g, ".*");
  re = re.replace(/\*/g, "[^/]*");
  return new RegExp("^" + re + "$");
}

// Resolve a manifest's globs under `root` into a sorted, de-duplicated file
// list. Recursive `**` supported.
export function gatherFiles(root, globs) {
  const all = walk(root);
  const matchers = globs.map(globToRegExp);
  const set = new Set();
  for (const f of all) {
    const rel = relative(root, f);
    if (matchers.some((m) => m.test(rel))) set.add(f);
  }
  return [...set].sort();
}

// [(path, text)] with filename markers so findings attribute back to a file.
export function readConcat(paths) {
  const chunks = [];
  for (const p of paths) {
    try { chunks.push([p, readFileSync(p, "utf8")]); }
    catch { /* skip unreadable */ }
  }
  return chunks;
}

// All .sql files directly inside a flat fixtures dir.
export function listSql(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => join(dir, f))
    .sort();
}

const CREATE = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z_][a-z0-9_]*)/gi;

// Set of table names created in this SQL (schema prefix stripped).
export function createdTables(sqlText) {
  const set = new Set();
  let m;
  CREATE.lastIndex = 0;
  while ((m = CREATE.exec(sqlText)) !== null) set.add(m[1].toLowerCase());
  return set;
}

// True iff `alter table [public.]<table> enable row level security` appears.
export function tableHasRls(sqlText, table) {
  const re = new RegExp(
    `alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:public\\.)?${escapeRe(table)}` +
    `\\s+enable\\s+row\\s+level\\s+security`, "i");
  return re.test(sqlText);
}

// Roles that baseline grants are REVOKEd from for a table.
// Matches `revoke ... on [public.]<table> from <roles>`.
export function revokesForTable(sqlText, table) {
  const roles = new Set();
  const re = new RegExp(
    `revoke\\s+[^;]+?\\s+on\\s+(?:table\\s+)?(?:public\\.)?${escapeRe(table)}` +
    `\\s+from\\s+([a-z_,\\s]+)`, "gi");
  let m;
  while ((m = re.exec(sqlText)) !== null) {
    for (let r of m[1].split(",")) {
      r = r.trim().replace(/;$/, "").trim();
      if (r) roles.add(r.toLowerCase());
    }
  }
  return roles;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export { basename, statSync };
