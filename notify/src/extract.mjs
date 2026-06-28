// packages/notify/src/extract.mjs — FREE, local, no-LLM message body builder.
//
// Turns Claude Code's final response (from the session transcript) into a
// phone-readable notification body. No model call — selection only, so it costs
// nothing and never leaves the machine. The selection works on the response's
// MARKDOWN STRUCTURE (headings, list items, the trailing question) rather than
// regex sentence-splitting, which mangles paths/filenames/[TAGS].
//
// What we keep: the opening status line, section headings (as short labels),
// list items (the actual points), and any trailing question (always — it's the
// ask). What we drop: fenced code blocks, tables, and markdown markup. Length is
// budgeted by CHARACTERS (not a sentence count), well under Telegram's 4096.

import { readFileSync } from "node:fs";

/** The final assistant PROSE from a Claude Code transcript (.jsonl). Scans from
 *  the end for the last assistant entry that has text blocks (trailing entries
 *  are often tool_use-only). Returns "" if unreadable — caller degrades. */
export function lastAssistantText(transcriptPath) {
  let lines;
  try { lines = readFileSync(transcriptPath, "utf8").split("\n"); } catch { return ""; }
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i].trim();
    if (!raw) continue;
    let o; try { o = JSON.parse(raw); } catch { continue; }
    if ((o.type || o.message?.role) !== "assistant") continue;
    const content = o.message?.content ?? o.content;
    if (!Array.isArray(content)) continue;
    const texts = content.filter((b) => b && b.type === "text" && b.text && b.text.trim());
    if (texts.length) return texts.map((b) => b.text).join("\n\n").trim();
  }
  return "";
}

/** Strip inline markdown so a line reads cleanly as plain text. */
function clean(s) {
  return s
    .replace(/!?\[([^\]]+)\]\([^)]*\)/g, "$1") // links/images → text
    .replace(/`([^`]+)`/g, "$1")               // inline code
    .replace(/\*\*([^*]+)\*\*/g, "$1")         // bold
    .replace(/\*([^*]+)\*/g, "$1")             // italic
    .replace(/__([^_]+)__/g, "$1")
    .replace(/^\s*>\s?/, "")                    // blockquote marker
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build the notification body from response markdown.
 * @param {string} md
 * @param {{maxChars?:number}} opts
 * @returns {string} newline-joined, cleaned units (• for list items)
 */
export function selectBody(md, { maxChars = 2500 } = {}) {
  if (!md || !md.trim()) return "";
  const t = md.replace(/```[\s\S]*?```/g, " ").replace(/~~~[\s\S]*?~~~/g, " ");

  const units = [];
  for (const line of t.split("\n")) {
    const L = line.trim();
    if (!L) continue;
    if (/^\|/.test(L) || /^[-:|\s]+$/.test(L)) continue;          // table rows / rule lines
    if (/^#{1,6}\s+/.test(L)) { const h = clean(L.replace(/^#{1,6}\s+/, "")); if (h) units.push(h); continue; }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(L)) { const it = clean(L.replace(/^\s*([-*+]|\d+[.)])\s+/, "")); if (it) units.push("• " + it); continue; }
    const c = clean(L);
    if (c) units.push(c);
  }
  if (!units.length) return "";

  // The trailing question is the ask — guarantee it survives the budget.
  let lastQuestion = null;
  for (let i = units.length - 1; i >= 0; i--) { if (/\?\s*$/.test(units[i])) { lastQuestion = units[i]; break; } }

  const out = [];
  let len = 0;
  for (const u of units) {
    if (len + u.length + 1 > maxChars) break;
    out.push(u); len += u.length + 1;
  }
  if (lastQuestion && !out.includes(lastQuestion)) {
    while (out.length && len + lastQuestion.length + 2 > maxChars) { const r = out.pop(); len -= r.length + 1; }
    out.push("…", lastQuestion);
  }
  return out.join("\n");
}

/** Convenience: transcript path → body. */
export function bodyFromTranscript(transcriptPath, opts) {
  return selectBody(lastAssistantText(transcriptPath), opts);
}
