#!/bin/bash
# Resolve vault: references in env vars, then exec the real command.
# Claude Code launches this as the MCP server "command". The actual
# server command + args are passed as arguments to this script.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Find node binary
NODE=""
for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
  if [ -x "$candidate" ]; then NODE="$candidate"; break; fi
done
if [ -z "$NODE" ]; then
  NODE="$(command -v node 2>/dev/null || true)"
fi
if [ -z "$NODE" ]; then
  echo "vault-env-wrapper: node not found" >&2
  exit 1
fi

# Collect vault: references from env
REFS=""
for var in $(env | grep '=vault:' | cut -d= -f1); do
  val="${!var}"
  secret_id="${val#vault:}"
  REFS="${REFS}${var}=${secret_id}"$'\n'
done

if [ -n "$REFS" ]; then
  # VAULTNEMA912: vault-resolve now fails LOUD (exit 2 = malformed ref line,
  # exit 3 = missing secret) instead of silent success. DELIBERATE CHOICE
  # (option a, measured with Marveen): the MCP server still starts. This
  # wrapper's job is launching; a stale vault: reference must not become a
  # fleet-wide startup failure. The truth goes to stderr (vault-resolve has
  # already named the offending label/line there), and the RESOLVED SUBSET is
  # still exported -- vault-resolve keeps printing the good lines in a mixed
  # batch. The `|| RC=$?` shape is what keeps `set -e` from killing the
  # wrapper before `exec` under the new contract.
  RC=0
  RESOLVED=$(printf '%s' "$REFS" | "$NODE" "$PROJECT_ROOT/scripts/vault-resolve.mjs") || RC=$?
  if [ "$RC" -ne 0 ]; then
    echo "vault-env-wrapper: vault-resolve exit $RC -- not every vault: reference resolved; starting anyway with the resolved subset" >&2
  fi
  # Split each line on the FIRST '=' only, preserving '=' inside/at-end of the
  # value (e.g. base64 keys with '=' padding). `IFS='=' read -r key value`
  # drops a single trailing '=' (PAD1=abc= became abc), so use parameter
  # expansion instead.
  SKIPPED=0
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    # Only KEY=value lines are exported. Anything else on vault-resolve's stdout (a log line, Mac mini
    # 2026-10-22) is skipped and counted, never echoed (it is not ours to print); an export of it would
    # fail under set -e and the MCP server would not start at all.
    if [[ ! "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then SKIPPED=$((SKIPPED + 1)); continue; fi
    key="${line%%=*}"
    value="${line#*=}"
    export "$key"="$value"
  done <<< "$RESOLVED"
  [ "$SKIPPED" -gt 0 ] && echo "vault-env-wrapper: $SKIPPED non KEY=value line(s) on vault-resolve's stdout ignored" >&2
  true
fi

exec "$@"
