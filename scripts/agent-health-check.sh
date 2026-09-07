#!/bin/bash
# Marveen agent health check -- can every declared agent actually be loaded?
#
# Pure observation, no side effects: reads config files only, never starts an
# agent and never runs `claude`. (Any `claude ...` invocation from a live
# session tears down the channel-plugin MCP connection -- see the
# csatorna-plugin-lecsatlakozas skill.)
#
# WHY IT EXISTS. A broken agent definition -- a typo in the model id, a
# CLAUDE.md that never got copied, a .mcp.json with a trailing comma -- stays
# invisible until the moment that agent is actually invoked, which on a fleet
# driven by scheduled tasks can be days later and in the middle of real work.
# This turns "it failed when we needed it" into "it is red on the report".
#
# Modelled on ops/scripts/agent_health_check.ts from the mcp-brunella-core
# project, which validates every registry entry resolves to a loadable module.
#
# Run: bash scripts/agent-health-check.sh
# Exit 0 = every agent OK, 1 = at least one FAIL.

set -u
INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$INSTALL_DIR"

GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; DIM='\033[2m'; BOLD='\033[1m'; RESET='\033[0m'

OK_N=0; FAIL_N=0; SKIP_N=0
AGENT_FAILED=0

ok()   { echo -e "    ${GREEN}✓${RESET} $1"; }
warn() { echo -e "    ${YELLOW}⚠${RESET} $1"; }
bad()  { echo -e "    ${RED}✗${RESET} $1"; AGENT_FAILED=1; }
skip() { echo -e "    ${DIM}-${RESET} $1"; }

# SEVERITY RULE. Only fail on what actually breaks loading, verified against
# src/web/agent-config.ts rather than assumed:
#   - displayName absent -> readAgentDisplayName() falls back to the title-cased
#     agent name (line ~152). NOT fatal, warn.
#   - engine absent/unknown -> readAgentEngine() falls back to 'claude'
#     (line ~177). NOT fatal, warn.
#   - model absent -> resolveAgentModelDetailed() falls back to DEFAULT_MODEL
#     (line ~112). NOT fatal, warn.
#   - agent-config.json MALFORMED -> every reader catches the parse error and
#     silently uses defaults, so the agent still starts but runs on the WRONG
#     model with none of its configured settings. Silent misconfiguration is
#     worse than a crash, so this one DOES fail.
#   - model present but violating MODEL_ID_RE -> rejected downstream. Fails.
# The first version of this script failed any agent missing displayName, which
# flagged a perfectly working `lumen`. Checking the fallbacks first is the
# difference between a health check and a noise generator.

MAIN_AGENT_ID="$(grep -E '^MAIN_AGENT_ID=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d ' "')"
MAIN_AGENT_ID="${MAIN_AGENT_ID:-marveen}"

DESIRED_FILE="store/agents-desired.json"

echo -e "\n${BOLD}Marveen Agent Health${RESET}: $(date '+%Y-%m-%d %H:%M:%S')"

if [ ! -f "$DESIRED_FILE" ]; then
  echo -e "\n  ${RED}✗${RESET} $DESIRED_FILE missing -- cannot tell which agents should exist."
  exit 1
fi

AGENTS=$(python3 -c "
import json,sys
try: d=json.load(open('$DESIRED_FILE'))
except Exception as e: print('PARSE_ERROR', e, file=sys.stderr); sys.exit(1)
print('\n'.join(str(a) for a in d) if isinstance(d,list) else '')
" 2>/dev/null)

if [ -z "$AGENTS" ]; then
  echo -e "\n  ${RED}✗${RESET} $DESIRED_FILE is empty or not a JSON array."
  exit 1
fi

# --- Per-agent checks ---
while IFS= read -r agent; do
  [ -z "$agent" ] && continue
  AGENT_FAILED=0
  echo -e "\n  ${BOLD}${agent}${RESET}"
  dir="agents/$agent"

  if [ ! -d "$dir" ]; then
    bad "directory missing: $dir"
    FAIL_N=$((FAIL_N+1))
    continue
  fi

  # 1. agent-config.json -- must exist and parse
  cfg="$dir/agent-config.json"
  if [ ! -f "$cfg" ]; then
    bad "agent-config.json missing"
  else
    CFG_OUT=$(python3 -c "
import json,sys,re
try: c=json.load(open('$cfg'))
except Exception as e:
    print('BAD_JSON|%s' % e); sys.exit(0)
if not isinstance(c,dict):
    print('BAD_JSON|top level is %s, expected object' % type(c).__name__); sys.exit(0)
# Absent fields are NOT failures -- each has a documented fallback (see the
# severity rule at the top of this script). Report them as fallback notices.
for k,fb in (('displayName','title-cased agent name'),('model','DEFAULT_MODEL'),('engine',\"'claude'\")):
    if not c.get(k): print('FALLBACK|%s|%s' % (k,fb))
m=c.get('model')
if isinstance(m,str) and not re.fullmatch(r'[A-Za-z0-9._:/\[\]-]{1,128}', m):
    print('BAD_MODEL|%s' % m[:60])
e=c.get('engine')
if e and e not in ('claude','copilot','antigravity'):
    print('BAD_ENGINE|%s' % str(e)[:40])
print('MODEL|%s' % (m or '(default)'))
print('ENGINE|%s' % (e or '(claude)'))
print('REPORTS|%s' % ((c.get('team') or {}).get('reportsTo') or ''))
" 2>/dev/null)

    if echo "$CFG_OUT" | grep -q '^BAD_JSON|'; then
      # Malformed config is NOT silently tolerable: every reader falls back to
      # defaults, so the agent boots on the wrong model with no settings.
      bad "agent-config.json unparseable -- ALL settings silently ignored, agent would run on defaults: $(echo "$CFG_OUT" | sed -n 's/^BAD_JSON|//p')"
    else
      if echo "$CFG_OUT" | grep -q '^BAD_MODEL|'; then
        bad "model id rejected by MODEL_ID_RE (src/model-id.ts): $(echo "$CFG_OUT" | sed -n 's/^BAD_MODEL|//p')"
      fi
      if echo "$CFG_OUT" | grep -q '^BAD_ENGINE|'; then
        bad "engine not in {claude, copilot, antigravity}: $(echo "$CFG_OUT" | sed -n 's/^BAD_ENGINE|//p')"
      fi
      MODEL=$(echo "$CFG_OUT" | sed -n 's/^MODEL|//p')
      ENGINE=$(echo "$CFG_OUT" | sed -n 's/^ENGINE|//p')
      REPORTS=$(echo "$CFG_OUT" | sed -n 's/^REPORTS|//p')
      if [ "$AGENT_FAILED" -eq 0 ]; then
        ok "config: model=$MODEL engine=$ENGINE"
      fi
      echo "$CFG_OUT" | sed -n 's/^FALLBACK|//p' | while IFS='|' read -r field fb; do
        warn "$field absent -- falls back to $fb (works, but not explicit)"
      done
      # reportsTo must name a real agent (or the main agent, which has no agents/ dir)
      if [ -n "$REPORTS" ] && [ "$REPORTS" != "$MAIN_AGENT_ID" ] && [ ! -d "agents/$REPORTS" ]; then
        bad "team.reportsTo points at unknown agent: $REPORTS"
      fi
    fi
  fi

  # 2. CLAUDE.md -- the persona. Missing or empty means the agent boots without
  #    its role, which is a silent behavioural failure, not a crash.
  if [ ! -f "$dir/CLAUDE.md" ]; then
    bad "CLAUDE.md missing (agent would boot with no persona)"
  elif [ ! -s "$dir/CLAUDE.md" ]; then
    bad "CLAUDE.md is empty"
  else
    ok "CLAUDE.md: $(wc -c < "$dir/CLAUDE.md" | tr -d ' ') bytes"
  fi

  # 3. Optional JSON files -- only validated if present
  for opt in ".mcp.json" ".claude/settings.json"; do
    f="$dir/$opt"
    if [ -f "$f" ]; then
      if ERR=$(python3 -c "import json;json.load(open('$f'))" 2>&1); then
        ok "$opt: valid JSON"
      else
        bad "$opt: invalid JSON -- $(echo "$ERR" | tail -1 | cut -c1-90)"
      fi
    else
      skip "$opt: not present (optional)"
    fi
  done

  # 4. tmux session -- informational only. An agent that is simply not running
  #    is not broken, so this never fails the check.
  if tmux has-session -t "agent-$agent" 2>/dev/null; then
    ok "tmux session agent-$agent: running"
  else
    skip "tmux session agent-$agent: not running (not an error)"
  fi

  if [ "$AGENT_FAILED" -eq 1 ]; then
    FAIL_N=$((FAIL_N+1))
  else
    OK_N=$((OK_N+1))
  fi
done <<< "$AGENTS"

# --- Orphan directories: present on disk but not declared ---
echo -e "\n  ${BOLD}Orphans${RESET}"
ORPHANS=0
for d in agents/*/; do
  [ -d "$d" ] || continue
  name=$(basename "$d")
  if ! echo "$AGENTS" | grep -qx "$name"; then
    warn "agents/$name exists but is not in $DESIRED_FILE"
    ORPHANS=$((ORPHANS+1))
    SKIP_N=$((SKIP_N+1))
  fi
done
[ "$ORPHANS" -eq 0 ] && ok "none"

# --- Summary ---
TOTAL=$((OK_N + FAIL_N))
echo ""
echo -e "  ${BOLD}total=${TOTAL}  ok=${OK_N}  fail=${FAIL_N}  skip=${SKIP_N}${RESET}"
if [ "$FAIL_N" -eq 0 ]; then
  echo -e "  ${GREEN}${BOLD}Every declared agent is loadable.${RESET}\n"
  exit 0
else
  echo -e "  ${RED}${BOLD}${FAIL_N} agent(s) would fail to load -- check the ✗ lines above.${RESET}\n"
  exit 1
fi
