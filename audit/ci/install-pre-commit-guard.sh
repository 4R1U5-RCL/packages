#!/usr/bin/env sh
# install-pre-commit-guard.sh — install the secret-leak pre-commit guard into a repo.
#
#   sh install-pre-commit-guard.sh /path/to/repo
#
# Idempotent: re-running overwrites the guard with the current version. Respects
# core.hooksPath. Refuses to clobber a pre-commit hook this installer did not
# write (it tags its own with a marker line).

set -eu

MARKER="# managed-by: audit/ci/pre-commit-secret-guard"
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/pre-commit-secret-guard.sh"

REPO="${1:?usage: install-pre-commit-guard.sh /path/to/repo}"
[ -d "$REPO/.git" ] || [ -f "$REPO/.git" ] || { echo "not a git repo: $REPO" >&2; exit 1; }

HOOKS_REL="$(git -C "$REPO" config --get core.hooksPath || true)"
if [ -n "$HOOKS_REL" ]; then
  case "$HOOKS_REL" in /*) HOOKS_DIR="$HOOKS_REL" ;; *) HOOKS_DIR="$REPO/$HOOKS_REL" ;; esac
else
  HOOKS_DIR="$REPO/$(git -C "$REPO" rev-parse --git-path hooks)"
fi
mkdir -p "$HOOKS_DIR"
DEST="$HOOKS_DIR/pre-commit"

if [ -e "$DEST" ] && ! grep -q "$MARKER" "$DEST" 2>/dev/null; then
  echo "refusing to overwrite existing unmanaged pre-commit hook: $DEST" >&2
  echo "inspect it, then remove/merge manually and re-run." >&2
  exit 1
fi

{ printf '%s\n' "$MARKER"; cat "$SRC"; } > "$DEST"
chmod +x "$DEST"
echo "installed secret-leak pre-commit guard -> $DEST"
