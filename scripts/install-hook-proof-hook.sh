#!/usr/bin/env bash
# Idempotent installer: push gate with per-commit proof that the pre-commit
# checks ran (scripts/hook-proof.mjs). Auto-run by scripts/sync-hooks.sh.
#
# Three small hooks, composed with the existing dispatchers:
#   pre-commit.d/90-hook-proof  -- last in the chain: only reached if every
#                                  earlier pre-commit check passed; remembers
#                                  the checked tree
#   post-commit.d/50-hook-proof -- records the new commit as verified
#   pre-push.d/20-hook-proof    -- blocks a push that carries unverified commits
#
# Deliberate bypass: MARVEEN_PUSH_PROOF_SKIP=1 git push ...
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK_DIR="$(cd "$(git -C "$ROOT" rev-parse --git-common-dir)" && pwd)/hooks"
mkdir -p "$HOOK_DIR/pre-commit.d" "$HOOK_DIR/post-commit.d" "$HOOK_DIR/pre-push.d"

write_subhook() { # $1 = path, $2 = hook-proof command
  cat > "$1" <<SUBHOOK
#!/usr/bin/env bash
# hook-proof ($2): managed by scripts/install-hook-proof-hook.sh -- edit there.
set -euo pipefail
if ! command -v node >/dev/null 2>&1; then
  echo "hook-proof: node not found -- cannot record/verify proof (fail-closed)." >&2
  exit 1
fi
ROOT="\$(git rev-parse --show-toplevel)"
exec node "\$ROOT/scripts/hook-proof.mjs" $2 "\$@"
SUBHOOK
  chmod +x "$1"
}

write_subhook "$HOOK_DIR/pre-commit.d/90-hook-proof" pre-commit
write_subhook "$HOOK_DIR/post-commit.d/50-hook-proof" post-commit
write_subhook "$HOOK_DIR/pre-push.d/20-hook-proof" pre-push

# post-commit dispatcher (there was none before; mirrors the pre-commit one).
DISPATCH="$HOOK_DIR/post-commit"
MARK="marveen-post-commit-dispatcher"
if [ -f "$DISPATCH" ] && ! grep -q "$MARK" "$DISPATCH" 2>/dev/null; then
  mv "$DISPATCH" "$HOOK_DIR/post-commit.d/00-existing-postcommit"
  chmod +x "$HOOK_DIR/post-commit.d/00-existing-postcommit"
  echo "  (preserved existing post-commit as post-commit.d/00-existing-postcommit)"
fi
cat > "$DISPATCH" <<DISPATCHER
#!/usr/bin/env bash
# $MARK : run every executable in post-commit.d/.
set -euo pipefail
HOOK_DIR="\$(cd "\$(dirname "\$0")" && pwd)"
status=0
for h in "\$HOOK_DIR"/post-commit.d/*; do
  [ -x "\$h" ] || continue
  "\$h" "\$@" || status=1
done
exit \$status
DISPATCHER
chmod +x "$DISPATCH"

# The pre-commit / pre-push dispatchers come from the sibling installers; if
# this one runs first on a fresh clone, make sure they exist too.
[ -f "$HOOK_DIR/pre-commit" ] || bash "$ROOT/scripts/install-secret-gate-hook.sh" >/dev/null
[ -f "$HOOK_DIR/pre-push" ] || bash "$ROOT/scripts/install-git-guard-hook.sh" >/dev/null

echo "✓ hook-proof: push gate with pre-commit proof installed."
