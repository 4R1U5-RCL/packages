---
name: diagnose-secret
description: Diagnose a secret that looks right but 401s at runtime — narrow to one of the four PAT-11 causes, never echoing the value
argument-hint: <secret-name-or-env-var> [--project=<ref>]
allowed-tools: [Read, Bash]
user-invocable: true
---

# diagnose-secret

Diagnose a credential that *looks* correct (decodes / right shape / byte-identical to
the canonical copy) but fails at runtime — a 401, a wrong endpoint, or no effect after
a claimed rotation. This is the PAT-11 playbook: "decodes but 401" has **four**
suspects, and this skill narrows to the most likely one and names the fix.

> **CRITICAL — PAT-6.** NEVER print, echo, or write the secret value to output. Work
> in **lengths, fingerprints, file paths, and HTTP status codes only**. Treat any key
> seen in chat or a log as burned. Every bash block below is written to avoid echoing
> the value; do not relax that.

The four PAT-11 causes this skill distinguishes:

1. **Truncation (TE-18)** — long single-line JWTs clip on copy-paste; they still
   decode to the right role/iat but the signature tail is cut, so every call 401s.
2. **Wrong-project (TE-18)** — a byte-valid key pointed at the wrong project/endpoint.
3. **Stale / desynced (IN-13)** — host `.env` edits never reached the live container;
   mtime frozen, the "rotated" key never took effect.
4. **Legacy-key-system disabled (TE-21)** — Supabase's new API-key system disables
   legacy `anon`/`service_role` JWTs for PostgREST, so a byte-correct legacy key
   `PGRST301`s on `/rest/v1/` while still *passing* GoTrue (`/auth/v1/settings`).

## Shell conventions (applies to all bash blocks)

- `set -euo pipefail`; quote every expansion.
- **Never expand the secret into a printable position.** Read it into a variable and
  only ever emit `${#VAR}` (length) or a hash — never `echo "$VAR"`, never put it in
  a URL query, never log it.
- Fingerprint = first 4 + last 4 chars, or a SHA-256 prefix. That is the most that
  ever leaves this skill.
- No `jq` in the container — parse JSON with `python3` (PAT-9).

## Procedure

### 1. Length + format check — detect truncation (cause 1) WITHOUT printing the value

```bash
set -euo pipefail
# Pull the value into a var without echoing it. Adjust source to where it lives.
SECRET_NAME="<secret-name-or-env-var>"
ENV_FILE="<path-to-.env-or-secret-store>"
VAL="$(grep -m1 "^${SECRET_NAME}=" "$ENV_FILE" | cut -d= -f2-)"
# Emit ONLY length + fingerprint — never the value itself.
printf 'len=%s  fp=%s..%s  sha=%s\n' \
  "${#VAL}" "${VAL:0:4}" "${VAL: -4}" \
  "$(printf '%s' "$VAL" | sha256sum | cut -c1-12)"
```

- For a JWT: split on `.` into 3 parts; base64url-decode the **header + payload only**
  (never the signature) with `python3` to confirm role/iat/project ref. A JWT that
  decodes fine but is short on total length is the truncation signature.
- Compare `len` + `fp` against the canonical copy's length/fingerprint (pulled
  programmatically, e.g. Supabase Management API) — **a length or fingerprint mismatch
  here is cause 1 (truncation) or a desync**, without ever comparing raw values.

### 2. Confirm which project/endpoint the secret targets — wrong-project (cause 2)

- For a JWT, decode the payload's project `ref` / issuer (header+payload only) and
  check it equals `--project=<ref>` (or the project the failing app expects).
- Confirm the app's configured base URL points at that same project.
- A valid key whose embedded ref ≠ the target project is cause 2.

### 3. LIVE PROBE the actual failing data endpoint — distinguishes cause 4

This is the step that separates "legacy-key-system disabled" from the rest. Probe the
**data** endpoint, not just auth — they can disagree.

```bash
set -euo pipefail
BASE="https://<project-ref>.supabase.co"
# Probe the DB endpoint specifically. -o /dev/null so the body (which may echo the
# key context) is discarded; we read ONLY the status code.
echo "rest:  $(curl -s -o /dev/null -w '%{http_code}' \
  -H "apikey: $VAL" -H "Authorization: Bearer $VAL" "$BASE/rest/v1/")"
echo "auth:  $(curl -s -o /dev/null -w '%{http_code}' \
  -H "apikey: $VAL" "$BASE/auth/v1/settings")"
```

- `/rest/v1/` → **401 / `PGRST301`** while `/auth/v1/settings` → **200** is the TE-21
  signature: the legacy key system is disabled — migrate to
  `sb_publishable` / `sb_secret`. **Probing only `/auth/v1/settings` would hide this**,
  because a disabled legacy key still passes GoTrue.
- Both 401 → fall back to causes 1–3 (truncation / wrong-project / desync).
- For non-Supabase secrets, probe the actual data API that's failing, not a health/
  metadata endpoint.

### 4. Confirm the change landed INSIDE the container — stale/desync (cause 3)

```bash
set -euo pipefail
# mtime + fingerprint of the secret as the LIVE container sees it (not the host copy).
docker exec -u node <container> stat -c '%y %n' "<path-in-container-to-.env>" 2>/dev/null || \
  stat -c '%y %n' "$ENV_FILE"
# Re-fingerprint the in-container value and compare to step 1's fp — same caveat: no echo.
```

- mtime frozen at an old timestamp, or in-container fingerprint ≠ the edited host
  value, means the edit never reached the live process (IN-13) — cause 3. Host `.env`
  edits do not propagate into the running container by themselves; `source .env` does
  not export to subprocesses (PAT-9).

### 5. Check legacy vs new key system (if Supabase / applicable)

- If step 3 showed the `/rest/v1` 401 + `/auth/v1` 200 split, confirm the project is
  on the new API-key system and the app is using `sb_publishable` / `sb_secret`
  (env.local **and** the deploy platform's env), then redeploy. Legacy
  `anon`/`service_role` JWTs are the wrong key class on a migrated project (TE-21).

### 6. Report — most likely cause + the fix

Report (no secret values — lengths/fingerprints/status codes/paths only):

```
Secret: <name>  (len=<n>, fp=XXXX..XXXX)
Targets: project <ref> / <base url>   [matches expected: yes/no]
Probe:   /rest/v1 -> <code>   /auth/v1/settings -> <code>
Landed:  in-container mtime <ts>, fp <matches host: yes/no>

Most likely cause: <1 truncation | 2 wrong-project | 3 stale-desync | 4 legacy-key-disabled>
Why: <the one discriminating signal>
Fix: <pull programmatically & rewrite in place (never hand-copy) | repoint project |
      propagate into container & restart | migrate to sb_publishable/sb_secret + redeploy>
```

## Constraints

- **NEVER print the secret value** to stdout, the report, a file, a URL, or a log
  (PAT-6). Lengths, fingerprints (first/last 4 or a hash prefix), file paths, and HTTP
  status codes are the only things that may leave this skill.
- Read-only diagnosis — this skill does not rotate or rewrite the secret. If the cause
  is truncation or desync, the *fix* is to pull the canonical value programmatically
  (e.g. Supabase Management API) and write it in place — never hand-copy a long secret
  (PAT-11 guard). Hand off the actual write/rotation; recommend, don't execute.
- Always probe `/rest/v1/` specifically for Supabase — `/auth/v1/settings` alone hides
  the legacy-key-disabled cause (TE-21).
- Confirm the change landed **inside the container** before trusting any edit (IN-13);
  `$HOME` is unreliable in hook subshells, use absolute paths (PAT-9).

## Reference

- `/studio/ERRORS_AND_FINDINGS.md` — PAT-11 (decodes-but-401, the four causes),
  PAT-6 (never echo secrets), PAT-9 (container reality), TE-18 / IN-13 / TE-21.
- Grep `ERRORS_AND_FINDINGS.md` before debugging any build/deploy/secret issue.
