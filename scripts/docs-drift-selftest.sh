#!/usr/bin/env bash
# Self-test for docs-drift.mjs on a throwaway tree (never the live repo).
# Both directions: a current tree passes; a stale block, a dead index link, a
# hook pointing at a missing script, and an undocumented seed task each FAIL.
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
ok()  { echo "  ok   $1"; pass=$((pass+1)); }
bad() { echo "  FAIL $1"; fail=$((fail+1)); }
run() { DOCS_DRIFT_ROOT="$TMP/t" node "$SRC/scripts/docs-drift.mjs" "$@"; }
# --check exits 1 on drift BY DESIGN; under pipefail that would mask a grep hit, so capture first.
out() { DOCS_DRIFT_ROOT="$TMP/t" node "$SRC/scripts/docs-drift.mjs" "$@" 2>&1 || true; }

mk() { # a minimal, consistent tree
  rm -rf "$TMP/t"; mkdir -p "$TMP/t"/{agents/alpha,src/web/routes,.claude,scripts/hooks,scheduled-tasks/daily,docs}
  echo x > "$TMP/t/agents/alpha/CLAUDE.md"
  printf "const p = '/api/things'\n" > "$TMP/t/src/web/routes/things.ts"
  printf '{"hooks":{"Stop":[{"hooks":[{"command":"python3 \\"$CLAUDE_PROJECT_DIR/scripts/hooks/guard.py\\""}]}]}}' > "$TMP/t/.claude/settings.json"
  echo x > "$TMP/t/scripts/hooks/guard.py"
  printf '{"mcpServers":{"a":{}}}' > "$TMP/t/.mcp.json"
  printf '# Ütemezett\n\n- `daily`: naponta.\n' > "$TMP/t/docs/scheduled-tasks.md"
  printf '# Doksik\n\n| Lap |\n|---|\n| [Ütemezett](scheduled-tasks.md) |\n' > "$TMP/t/docs/README.md"
  echo x > "$TMP/t/docs/orphan.md"
}

mk
if run --check >/dev/null 2>&1; then bad "missing block should fail --check"; else ok "missing managed block fails --check"; fi
run --write >/dev/null && grep -q "DOC_STATS_START" "$TMP/t/docs/README.md" && ok "--write inserts the block" || bad "--write did not insert the block"
grep -q "orphan" "$TMP/t/docs/README.md" && ok "unlinked page listed in the block" || bad "unlinked page not listed"
if run --check >/dev/null; then ok "consistent tree passes --check"; else bad "consistent tree failed --check"; fi

# stale block: a new agent appears, the block still says 1
mkdir -p "$TMP/t/agents/beta" && echo x > "$TMP/t/agents/beta/CLAUDE.md"
if grep -q "STALE" <<<"$(out --check)"; then ok "new agent makes the block STALE"; else bad "new agent not detected"; fi
run --write >/dev/null && run --check >/dev/null && ok "--write brings it current again" || bad "rewrite did not fix staleness"

# dead link in the index
printf '| [Nincs](nincs.md) |\n' >> "$TMP/t/docs/README.md"
if grep -q "nem létező lapot: nincs.md" <<<"$(out --check)"; then ok "dead index link is DRIFT"; else bad "dead link not detected"; fi
mk; run --write >/dev/null

# hook pointing at a missing script
rm "$TMP/t/scripts/hooks/guard.py"
if grep -q "nem létező szkriptre mutat: scripts/hooks/guard.py" <<<"$(out --check)"; then ok "hook with missing script is DRIFT"; else bad "missing hook script not detected"; fi
mk; run --write >/dev/null

# undocumented seed task
mkdir -p "$TMP/t/scheduled-tasks/nightly"
if grep -q "nem említ: nightly" <<<"$(out --check)"; then ok "undocumented seed task is DRIFT"; else bad "undocumented seed task not detected"; fi
# --write does NOT paper over a cross-check
if run --write >/dev/null 2>&1; then bad "--write hid a cross-check failure"; else ok "--write still exits 1 on a cross-check failure"; fi

echo "docs-drift selftest: $pass ok, $fail fail"
[ "$fail" -eq 0 ]
