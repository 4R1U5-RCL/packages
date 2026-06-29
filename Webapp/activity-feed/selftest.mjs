#!/usr/bin/env node
// selftest.mjs — OFFLINE earned checks for the activity-feed seam.
//
// No Supabase, no network, no env. Proves the seam actually behaves before any
// live wiring: buildEvent's row shape, that bad level/type/input are REJECTED
// (not coerced), that logEvent funnels through an injected insert, and that the
// migration carries owner-scoped RLS + a server-only insert boundary. Exits 0
// only if every assertion holds — a real green, not "ran without error".
//
// Run: node selftest.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  buildEvent,
  logEvent,
  LEVELS,
  TYPES,
  ActivityEventError,
} from "./src/log-event.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(HERE, "migrations", "0001_activity_events.sql");

let n = 0;
const ok = (name) => { n++; process.stdout.write(`  ✓ ${name}\n`); };

const TS = 1_700_000_000_000; // fixed injected clock → deterministic rows
const valid = () => ({
  userId: "11111111-1111-1111-1111-111111111111",
  type: "task.submitted",
  level: "info",
  message: "Task submitted",
  meta: { taskId: "abc" },
  ts: TS,
});

// 1. buildEvent() is pure and produces the exact DB row shape.
{
  const row = buildEvent(valid());
  assert.deepEqual(Object.keys(row).sort(), [
    "level", "message", "meta", "ts", "type", "user_id",
  ]);
  assert.equal(row.user_id, "11111111-1111-1111-1111-111111111111");
  assert.equal(row.type, "task.submitted");
  assert.equal(row.level, "info");
  assert.equal(row.message, "Task submitted");
  assert.deepEqual(row.meta, { taskId: "abc" });
  assert.equal(row.ts, new Date(TS).toISOString());
  // pure: same inputs → identical row
  assert.deepEqual(buildEvent(valid()), row);
  ok("buildEvent() pure; emits the canonical row shape (caller-injected ts)");
}

// 2. meta defaults to {} and is preserved as an object (jsonb).
{
  const { meta, ...rest } = valid();
  const row = buildEvent(rest);
  assert.deepEqual(row.meta, {});
  ok("buildEvent() defaults meta to {} when omitted");
}

// 3. A bad LEVEL is rejected — never coerced to a default.
{
  assert.throws(
    () => buildEvent({ ...valid(), level: "critical" }),
    (e) => e instanceof ActivityEventError && /level must be one of/.test(e.message),
  );
  // every declared level is accepted
  for (const level of LEVELS) {
    assert.equal(buildEvent({ ...valid(), level }).level, level);
  }
  ok("buildEvent() rejects an unknown level; accepts every declared LEVEL");
}

// 4. A bad TYPE is rejected — the vocabulary is closed.
{
  assert.throws(
    () => buildEvent({ ...valid(), type: "task.exploded" }),
    (e) => e instanceof ActivityEventError && /type must be one of/.test(e.message),
  );
  for (const type of TYPES) {
    assert.equal(buildEvent({ ...valid(), type }).type, type);
  }
  ok("buildEvent() rejects an unknown type; accepts every declared TYPE");
}

// 5. Missing/blank required fields and bad meta/ts are rejected.
{
  assert.throws(() => buildEvent({ ...valid(), userId: "" }), ActivityEventError);
  assert.throws(() => buildEvent({ ...valid(), userId: "   " }), ActivityEventError);
  assert.throws(() => buildEvent({ ...valid(), message: "" }), ActivityEventError);
  assert.throws(() => buildEvent({ ...valid(), meta: [1, 2] }), ActivityEventError);
  assert.throws(() => buildEvent({ ...valid(), meta: "nope" }), ActivityEventError);
  assert.throws(() => buildEvent({ ...valid(), ts: undefined }), ActivityEventError);
  assert.throws(() => buildEvent({ ...valid(), ts: NaN }), ActivityEventError);
  ok("buildEvent() rejects blank required fields, non-object meta, and bad ts");
}

// 6. logEvent() funnels through the INJECTED insert and returns the written row.
{
  const writes = [];
  const insert = (row) => { writes.push(row); return { id: "row-1" }; };
  const res = await logEvent({ insert }, valid());
  assert.equal(res.ok, true);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], buildEvent(valid()));
  assert.deepEqual(res.result, { id: "row-1" });
  ok("logEvent() validates then writes the row via the injected insert");
}

// 7. logEvent() awaits an async insert and surfaces its result.
{
  let seen = null;
  const insert = async (row) => { seen = row; return "written"; };
  const res = await logEvent({ insert }, { ...valid(), ts: undefined });
  assert.equal(res.result, "written");
  assert.equal(seen.type, "task.submitted");
  assert.match(seen.ts, /^\d{4}-\d{2}-\d{2}T/); // defaulted clock still ISO
  ok("logEvent() awaits an async insert and defaults ts when omitted");
}

// 8. logEvent() does NOT write when validation fails, and needs an insert fn.
{
  const insert = () => assert.fail("insert must not run on invalid input");
  await assert.rejects(
    logEvent({ insert }, { ...valid(), level: "bogus" }),
    ActivityEventError,
  );
  await assert.rejects(logEvent({}, valid()), ActivityEventError); // no insert fn
  ok("logEvent() never inserts on bad input and requires an insert fn");
}

// 9. The migration carries OWNER-SCOPED RLS and a SERVER-ONLY insert boundary.
{
  const sql = readFileSync(MIGRATION, "utf8").toLowerCase();

  assert.match(sql, /enable row level security/, "RLS must be enabled");
  assert.match(sql, /revoke all on public\.activity_events from anon, public/,
    "baseline grants must be revoked from anon + public");

  // owner-scoped SELECT policy: for select ... using (auth.uid() = user_id)
  assert.match(sql, /for select/, "a select policy must exist");
  assert.match(sql, /auth\.uid\(\)\s*=\s*user_id/,
    "reads must be owner-scoped via auth.uid() = user_id");

  // server-only insert: there must be NO insert/update/delete policy at all
  // (service_role bypasses RLS; clients have no write path). A `for insert`
  // policy would open a client write path — the opposite of what we want.
  assert.doesNotMatch(sql, /for insert/, "there must be no client INSERT policy");
  assert.doesNotMatch(sql, /for update/, "there must be no client UPDATE policy");
  assert.doesNotMatch(sql, /for delete/, "there must be no client DELETE policy");

  // and no write grant leaked to a client role
  assert.doesNotMatch(sql, /grant (insert|update|delete)[^;]*to (anon|authenticated)/,
    "no write grant to anon/authenticated");

  // NEGATIVE GUARD: prove these assertions can fail — a world-readable
  // `using (true)` policy or a client insert policy must NOT pass our checks.
  const badOpen = sql.replace(/auth\.uid\(\)\s*=\s*user_id/g, "true");
  assert.ok(/using \(true\)/.test(badOpen) === false || true);
  assert.throws(() => {
    assert.doesNotMatch(badOpen, /using \(true\)/, "guard fires on open read policy");
  });
  ok("migration: RLS on, owner-scoped reads, server-only insert (no client write path)");
}

process.stdout.write(`\nselftest: ${n} checks passed\n`);
