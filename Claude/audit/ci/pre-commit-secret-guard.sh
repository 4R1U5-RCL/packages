#!/usr/bin/env sh
# pre-commit-secret-guard.sh — LOCAL git pre-commit guard.
#
# Runs the audit package's `secret-leak` control over the repo before each
# commit and BLOCKS the commit if a known-shape secret is found in a tracked
# source file, or if `.env` is not gitignored. This is the local-machine
# complement to GitHub push-protection/secret-scanning (which a free personal
# account cannot enable on private repos) — it catches a leak BEFORE it ever
# reaches a commit, where in a public repo it would be exposed forever.
#
# Reuses the SAME self-guarded detector the audit package ships (config, not a
# reimplemented regex) so this guard and the CI gate agree by construction.
#
# Behaviour:
#   * secret found / .env not ignored  -> BLOCK (exit 1)
#   * clean                            -> allow (exit 0)
#   * tooling missing / inconclusive   -> WARN, allow (exit 0)  [fail-open on
#       tooling so a moved path never wedges every commit into --no-verify habit;
#       fail-closed on an actual detected secret]
#
# Emergency bypass (use only when you are certain): git commit --no-verify

AUDIT_CHECK="/root/packages/Claude/audit/checks/secret-leak.mjs"

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
[ -z "$REPO_ROOT" ] && exit 0

if ! command -v node >/dev/null 2>&1; then
  echo "pre-commit secret guard: 'node' not found — skipping (NOT blocking)." >&2
  exit 0
fi
if [ ! -f "$AUDIT_CHECK" ]; then
  echo "pre-commit secret guard: audit check missing at $AUDIT_CHECK — skipping (NOT blocking)." >&2
  exit 0
fi

OUT="$(node "$AUDIT_CHECK" --target "$REPO_ROOT" 2>&1)"
STATUS="$(printf '%s' "$OUT" | sed -n 's/.*"status":"\([a-z]*\)".*/\1/p' | head -1)"

case "$STATUS" in
  pass)
    exit 0 ;;
  fail)
    echo "" >&2
    echo "🔒 COMMIT BLOCKED — secret-leak guard found a problem:" >&2
    printf '%s\n' "$OUT" | sed -n 's/.*"message":"\([^"]*\)".*/  • \1/p' >&2
    printf '%s\n' "$OUT" | sed -n 's/.*"evidence":"\([^"]*\)".*/  evidence: \1/p' >&2
    echo "" >&2
    echo "  Move the value into .env (gitignored), or remove it, then re-commit." >&2
    echo "  True emergency only: git commit --no-verify" >&2
    echo "" >&2
    exit 1 ;;
  *)
    echo "pre-commit secret guard: inconclusive (status='${STATUS:-none}') — allowing commit." >&2
    printf '%s\n' "$OUT" >&2
    exit 0 ;;
esac
