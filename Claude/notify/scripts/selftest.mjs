#!/usr/bin/env node
// scripts/selftest.mjs — OFFLINE earned checks for the seam (no network, no creds).
//
// Proves the pure parts actually behave before any live wiring exists: signature
// determinism, header/envelope shape, single-secret fallback, and the fail-soft
// not-wired path. Exits 0 only if every assertion holds (a real green, not a
// "ran without error"). Run: node scripts/selftest.mjs

import assert from "node:assert/strict";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRequest, notify, sign, NOTIFY_SCHEMA, TOKEN_HEADER, SIG_HEADER, TS_HEADER } from "../src/client.mjs";
import { selectBody, lastAssistantText } from "../src/extract.mjs";

let n = 0;
const ok = (name) => { n++; process.stdout.write(`  ✓ ${name}\n`); };

// 1. sign() is a stable HMAC-SHA256 hex digest.
{
  const s = sign("123.{}", "secret");
  assert.match(s, /^[0-9a-f]{64}$/);
  assert.equal(s, sign("123.{}", "secret"));     // deterministic
  assert.notEqual(s, sign("123.{}", "other"));   // key-sensitive
  ok("sign() deterministic, hex, key-sensitive");
}

// 2. buildRequest() is pure for a fixed ts, and the signature covers `${ts}.${body}`.
{
  const ev = { source: "claude-code", kind: "attention", message: "hi", ts: 1_700_000_000_000 };
  const r1 = buildRequest(ev, { token: "tok" });
  const r2 = buildRequest(ev, { token: "tok" });
  assert.equal(r1.body, r2.body);
  assert.equal(r1.headers[SIG_HEADER], r2.headers[SIG_HEADER]);
  assert.equal(r1.payload.schema, NOTIFY_SCHEMA);
  assert.equal(r1.headers[TOKEN_HEADER], "tok");
  assert.equal(r1.headers[TS_HEADER], "1700000000000");
  assert.equal(r1.headers[SIG_HEADER], sign(`1700000000000.${r1.body}`, "tok"));
  ok("buildRequest() pure; signature binds timestamp+body");
}

// 3. secret defaults to token, but an explicit secret overrides (two-secret mode).
{
  const ev = { source: "audit", message: "x", ts: 1 };
  const a = buildRequest(ev, { token: "tok" });
  const b = buildRequest(ev, { token: "tok", secret: "different" });
  assert.notEqual(a.headers[SIG_HEADER], b.headers[SIG_HEADER]);
  ok("explicit secret overrides token for HMAC");
}

// 4. notify() with no url/token is fail-soft not-wired — never throws, never a
//    silent success.
{
  const res = await notify({ source: "claude-code", message: "x" }, {});
  assert.equal(res.delivered, false);
  assert.equal(res.ok, false);
  assert.match(res.note, /NOT WIRED/);
  ok("notify() fail-soft + loud when not wired");
}

// 5. selectBody(): drops code/markup, keeps headings/bullets, guarantees the
//    trailing question, and respects the char budget.
{
  const md = [
    "## What I did",
    "Wired the **notifier** into `both` repos.",
    "",
    "```js",
    "const secret = 'do-not-leak';",
    "```",
    "- Pushed to `feat/notify`",
    "- Verified the [earned-pass](https://x.y)",
    "",
    "Want me to proceed?",
  ].join("\n");
  const body = selectBody(md, { maxChars: 2500 });
  assert.match(body, /Want me to proceed\?$/);      // trailing question kept, last
  assert.doesNotMatch(body, /do-not-leak|const secret/); // fenced code dropped
  assert.doesNotMatch(body, /\*\*|`|\]\(/);          // markup stripped
  assert.match(body, /• Pushed to feat\/notify/);    // list item kept + bulleted
  assert.match(body, /earned-pass/);                 // link text kept, url gone
  assert.doesNotMatch(body, /https:\/\//);
  ok("selectBody() keeps structure, drops code/markup, guarantees the question");

  // budget truncation adds an ellipsis and still ends on the question
  const long = Array.from({ length: 50 }, (_, i) => `- point number ${i} with some filler text`).join("\n") + "\nFinal ask?";
  const trimmed = selectBody(long, { maxChars: 200 });
  assert.ok(trimmed.length <= 220);
  assert.match(trimmed, /Final ask\?$/);
  ok("selectBody() budgets by chars and preserves the trailing question");
}

// 6. lastAssistantText(): pulls the last assistant entry that has text (skips
//    trailing tool_use-only entries).
{
  const p = join(tmpdir(), `notify-selftest-${process.pid}.jsonl`);
  const lines = [
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "do it" }] } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Here is the answer." }] } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: {} }] } }),
  ].join("\n");
  writeFileSync(p, lines);
  try {
    assert.equal(lastAssistantText(p), "Here is the answer.");
    assert.equal(lastAssistantText("/no/such/file.jsonl"), ""); // unreadable → degrade
    ok("lastAssistantText() finds last text entry, degrades on missing file");
  } finally { try { unlinkSync(p); } catch {} }
}

process.stdout.write(`\nselftest: ${n} checks passed\n`);
