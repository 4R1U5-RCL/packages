---
description: Apply a Supabase migration via the Management API and verify the table/policy + RLS landed
argument-hint: [<migration-file-or-sql>] [--project=<ref>]
allowed-tools: [Read, Bash, Grep]
---

Apply a Supabase schema migration and prove it took. In this environment the Postgres
wire protocol is **unreachable** (PAT-5: default-deny egress is ~80/443 only, so ports
5432/6543 are blocked; `psql` hangs 3–5 min then connect-timeouts, and anon/service API
keys can't run DDL anyway). The only working path for `CREATE TABLE` / `CREATE POLICY` is
**HTTPS via the Supabase Management API** — `POST /v1/projects/{ref}/database/query` with
an `sbp_…` Personal Access Token. This skill encodes that path, then verifies the change
landed AND that every new table has RLS enabled (a new table without RLS is a hard finding
per `packages/db/CLAUDE.md`).

Studio reference project: `studio/templates` = ref `uzedswjxbgiuymleteud` (the dormant
RLS/template project). Use the explicit `--project=<ref>` for any other target — never
invent a ref.

## Shell conventions (applies to all bash blocks below)

- Begin with `set -euo pipefail`. Quote every expansion (`"$REF"`, `"$PAT"`).
- **Never echo the PAT.** It is read from env (`SUPABASE_ACCESS_TOKEN`); reference it as
  `"$SUPABASE_ACCESS_TOKEN"`, never print it, never paste it into a doc (PAT-6/PAT-11:
  every project has leaked at least one secret — treat any token seen in chat as burned).
- All HTTP is HTTPS to `https://api.supabase.com`. No `psql`, no `:5432`, no `:6543`.
- Tooling note (PAT-9): in-container there is no `jq`/`supabase` CLI and `python3` may be
  absent — parse JSON with whatever is present; prefer `node -e` if available, else `grep`.

## Procedure

### 1. Resolve the target project ref and locate the migration SQL

- **Project ref:** take it from `--project=<ref>`. If omitted and the cwd is a studio
  client, read the ref from that client's config (`client.config.ts` / `.env`
  `SUPABASE_PROJECT_REF` or the project URL `https://<ref>.supabase.co`). For the
  template project the ref is `uzedswjxbgiuymleteud`. Do not guess — if no real ref
  resolves, stop and ask.
- **Migration SQL:** the argument is either an inline SQL string or a path. If it's a
  path, `Read` it. If it's a directory of migrations, enumerate `*.sql` in lexical
  (timestamp) order. Capture each individual statement — verification in step 4 keys off
  the object names (`CREATE TABLE <name>`, `CREATE POLICY ... ON <name>`).

```bash
set -euo pipefail
REF="${PROJECT_REF:?resolve the project ref first (--project=<ref>)}"
MIGRATION="${MIGRATION_PATH:?path to the .sql file or inline SQL}"
echo "Target project ref: $REF"
test -f "$MIGRATION" && wc -l "$MIGRATION" || echo "(treating argument as inline SQL)"
```

### 2. Confirm the `sbp_` PAT is available

The Management API authenticates with a Personal Access Token, distinct from the project's
anon/service keys (PAT-5: keep raw DB creds separate from API keys). It must already be in
the environment — do not prompt for it in plaintext, and never echo it.

```bash
set -euo pipefail
: "${SUPABASE_ACCESS_TOKEN:?SUPABASE_ACCESS_TOKEN (sbp_… PAT) not in env — source /studio/.env}"
case "$SUPABASE_ACCESS_TOKEN" in
  sbp_*) echo "PAT present (sbp_ prefix ok)";;
  *) echo "WARNING: token does not start with sbp_ — confirm it is a Management API PAT";;
esac
```

If it's missing: `set -a; . /studio/.env; set +a` (the studio env carries it as
`SUPABASE_ACCESS_TOKEN`). Note `source .env` does not export to subprocesses (PAT-9) — use
`set -a` so the curl subshell inherits it.

### 3. Apply the migration via the Management API query endpoint

Send each statement (or the whole migration) as `{"query": "<SQL>"}` to
`POST https://api.supabase.com/v1/projects/{ref}/database/query`. **Do not use `psql`** —
it will hang for minutes then time out (PAT-5). Build the JSON body safely so embedded
quotes/newlines in the SQL don't corrupt it (use `node`/`jq` if present rather than naive
string interpolation — PAT-6 injection-safety note).

```bash
set -euo pipefail
SQL="$(cat "$MIGRATION" 2>/dev/null || printf '%s' "$MIGRATION")"
# Safe JSON encoding of the SQL into {"query": ...}
if command -v node >/dev/null 2>&1; then
  BODY="$(SQL="$SQL" node -e 'process.stdout.write(JSON.stringify({query:process.env.SQL}))')"
elif command -v jq >/dev/null 2>&1; then
  BODY="$(jq -nc --arg q "$SQL" '{query:$q}')"
else
  echo "FAIL: need node or jq to encode the SQL safely"; exit 1
fi

curl -sS -X POST "https://api.supabase.com/v1/projects/${REF}/database/query" \
  -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$BODY"
```

- A `2xx` with a JSON array (often `[]` for DDL) means the statement ran.
- A `4xx` body carries the Postgres error message — read it and fix the SQL; do not retry
  blindly.
- For a multi-statement file, prefer applying it as one transactional `query` (the
  endpoint runs the whole string), or loop statement-by-statement if you need per-object
  error attribution.

### 4. Verify — object exists AND RLS is enabled (the RLS gotcha guard)

Re-query the catalog over the same endpoint to confirm the object now exists, then check
RLS state. **A new table without RLS enabled is a HARD finding** (`packages/db/CLAUDE.md`:
RLS by default; the template project's invariant is "all tables RLS-enabled, all policied,
none anon-readable"). Note the audit-package gotcha (`reference_audit-package`): the static
`rls`/`revoke` controls anchor on `CREATE TABLE` in-repo, so a Management-API migration that
only `ALTER`s an out-of-repo table yields `unknown` there — this live catalog check is the
authoritative confirmation.

```bash
set -euo pipefail
# Confirm table presence + RLS flag for the new object(s). Replace public.<table>.
VERIFY_SQL="select n.nspname as schema, c.relname as table, c.relrowsecurity as rls_enabled,
  (select count(*) from pg_policies p where p.schemaname=n.nspname and p.tablename=c.relname) as policy_count
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where c.relkind='r' and c.relname = '<table>';"
if command -v node >/dev/null 2>&1; then
  VBODY="$(SQL="$VERIFY_SQL" node -e 'process.stdout.write(JSON.stringify({query:process.env.SQL}))')"
else
  VBODY="$(jq -nc --arg q "$VERIFY_SQL" '{query:$q}')"
fi
curl -sS -X POST "https://api.supabase.com/v1/projects/${REF}/database/query" \
  -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$VBODY"
```

Evaluate the result:
- **Table missing** → migration did not take; report FAIL with the apply-step response.
- **`rls_enabled = false` on a newly created table** → HARD FINDING. The migration is
  incomplete: it must include `ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;` (and a policy +
  appropriate `REVOKE`). Do not report success — surface it and apply the RLS fix before
  closing out.
- **`rls_enabled = true` with `policy_count = 0`** → RLS on but no policy = table is
  effectively locked to nobody; flag as a WARNING (likely also incomplete).
- For `CREATE POLICY` migrations, confirm the policy name appears in `pg_policies`.

### 5. Report what was applied + RLS status

Concise summary (do not paste the PAT or full curl noise):

```
Migration applied: <file/inline> → project <ref>
- Statements: <n> applied, <k> ok, <f> errored
- Objects: <table/policy names>
- RLS: <table> rls_enabled=<true|false>, policies=<count>   [HARD FINDING if a new table is false]
Verification: <PASS | FAIL | RLS-FINDING>
Next: <fix RLS / re-run / done>
```

## Constraints

- **Management API only** for DDL. `psql` and direct `:5432`/`:6543` are unreachable
  (PAT-5) — never attempt them.
- The PAT (`SUPABASE_ACCESS_TOKEN`, `sbp_…`) is read from env, never printed, never written
  to a doc, never accepted via plaintext chat (PAT-6/PAT-11). Treat any exposed token as
  burned and rotate.
- Project ref must be a real resolved value (e.g. `uzedswjxbgiuymleteud` for
  studio/templates) — never invented.
- Every new table must end RLS-enabled and policied — verify it, don't assume it. A new
  table without RLS is a hard finding, not a pass.
- Read-only verification re-queries the catalog through the same HTTPS endpoint; do not
  shell out to any DB client.

## Reference

- Endpoint: `POST https://api.supabase.com/v1/projects/{ref}/database/query`, header
  `Authorization: Bearer sbp_…`, body `{"query": "<SQL>"}`.
- studio/templates project ref: `uzedswjxbgiuymleteud`.
- PAT-5 (Postgres unreachable → Management-API path): `/studio/ERRORS_AND_FINDINGS.md`.
- RLS-by-default + §8.1 shapes: `/studio/CLAUDE.md` → `packages/db`.
- Cross-surface RLS re-audit (the loop-closer): `~/packages/audit/` (`rls`/`revoke`).
