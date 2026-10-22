#!/bin/bash
# Contract tests for two gaps found on the Mac mini standby install (card 3301e6cf, 2026-10-22):
#   (1) the progress watchdogs and their installers ignored store/.standby -- on macOS sync-hooks.sh
#       installed AND loaded com.<id>.telegram-progress-watchdog, which scans the progress state synced
#       from the LIVE machine and talks to the Bot API with the synced token;
#   (2) doctor.sh compared `wc -l` output as a string with "0", and BSD wc (macOS) pads the count
#       ("       0"), so a clean macOS install showed false failures.
# Every case runs in both directions: with the marker nothing runs / without it the old behaviour stays.
# Run: bash scripts/__tests__/standby-watchdog-and-doctor-wc.test.sh
#
# Hermetic: each case gets its own install-root copy under a temp dir, HOME is a temp dir, launchctl /
# systemctl / pidof / uname / tmux / curl are PATH shims that only log, and the Bot API is a local stub.

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }
has() { case "$2" in *"$1"*) echo yes ;; *) echo no ;; esac; }

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
STUB_PID=""
trap '[ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null; rm -rf "$TMP"' EXIT
export DBUS_SESSION_BUS_ADDRESS="unix:path=/nonexistent-marveen-test"
export XDG_RUNTIME_DIR="$TMP/run"; mkdir -p "$XDG_RUNTIME_DIR"
if [ -x /bin/bash ]; then SYS_BASH=/bin/bash; else SYS_BASH="$(command -v bash)"; fi

# --- PATH shims: log argv, succeed (so the systemd branch reaches `enable --now`) ---
SHIM="$TMP/shim"; SHIM_LOG="$TMP/shim.log"; mkdir -p "$SHIM"; : > "$SHIM_LOG"
for s in launchctl systemctl pidof tmux; do
  printf '#!/bin/bash\necho "%s $*" >> "%s"\nexit 0\n' "$s" "$SHIM_LOG" > "$SHIM/$s"; chmod +x "$SHIM/$s"
done
printf '#!/bin/bash\necho "${FAKE_UNAME:-Linux}"\n' > "$SHIM/uname"; chmod +x "$SHIM/uname"
printf '#!/bin/bash\necho "curl $*" >> "%s"\necho 000\nexit 7\n' "$SHIM_LOG" > "$SHIM/curl"; chmod +x "$SHIM/curl"

# --- (1a) the installers: <provider> x <platform> x <standby> ---
echo ""
echo "(1a) progress-watchdog installers honour store/.standby"
make_root() { # dir provider
  mkdir -p "$1/scripts/hooks" "$1/store" "$1/.claude"
  cp "$REPO/scripts/install-$2-progress-hook.sh" "$REPO/scripts/retire-progress-watchdog.sh" "$1/scripts/"
  cp "$REPO/scripts/hooks/$2_progress_watchdog.py" "$1/scripts/hooks/"
  printf 'SERVICE_ID=testbot\nBOT_NAME=TestBot\nCHANNEL_PROVIDER=%s\n' "$2" > "$1/test.env"
}
for PROV in telegram slack; do
  for PLAT in Linux Darwin; do
    for MODE in standby normal; do
      R="$TMP/inst-$PROV-$PLAT-$MODE"; H="$R/home"; mkdir -p "$H"; make_root "$R" "$PROV"
      [ "$MODE" = standby ] && : > "$R/store/.standby"
      : > "$SHIM_LOG"
      OUT="$(HOME="$H" MARVEEN_ENV_FILE="$R/test.env" PATH="$SHIM:$PATH" FAKE_UNAME="$PLAT" "$SYS_BASH" "$R/scripts/install-$PROV-progress-hook.sh" 2>&1)"; RC=$?
      if [ "$PLAT" = Darwin ]; then UNIT="$H/Library/LaunchAgents/com.testbot.$PROV-progress-watchdog.plist"; START='^launchctl load .*progress-watchdog'
      else UNIT="$H/.config/systemd/user/testbot-$PROV-progress-watchdog.timer"; START='^systemctl --user enable --now testbot-.*progress-watchdog'; fi
      UNIT_THERE=no; [ -e "$UNIT" ] && UNIT_THERE=yes
      STARTED=no; grep -qE "$START" "$SHIM_LOG" && STARTED=yes
      if [ "$MODE" = standby ]; then
        assert_eq "$PROV [$PLAT] standby: exit 0" "0" "$RC"
        assert_eq "$PROV [$PLAT] standby: says [standby]" "yes" "$(has '[standby]' "$OUT")"
        assert_eq "$PROV [$PLAT] standby: NO daemon unit written (launchd would load it at login)" "no" "$UNIT_THERE"
        assert_eq "$PROV [$PLAT] standby: the daemon is NOT started" "no" "$STARTED"
      else
        assert_eq "$PROV [$PLAT] normal: exit 0" "0" "$RC"
        assert_eq "$PROV [$PLAT] normal: no [standby] line" "no" "$(has '[standby]' "$OUT")"
        assert_eq "$PROV [$PLAT] normal: the daemon unit is written" "yes" "$UNIT_THERE"
        assert_eq "$PROV [$PLAT] normal: the daemon is started" "yes" "$STARTED"
      fi
    done
  done
done

# --- (1b) the Telegram watchdog itself: a wedged turn, with and without the marker ---
echo ""
echo "(1b) telegram_progress_watchdog.py does nothing in standby, delivers without it"
REQLOG="$TMP/requests.log"; PORTFILE="$TMP/port"
cat > "$TMP/stub.py" <<'PYEOF'
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0)); body = self.rfile.read(n).decode() if n else ""
        with open(sys.argv[1], "a") as f: f.write(self.path.rsplit("/", 1)[-1] + " " + body + "\n")
        p = json.dumps({"ok": True, "result": {"message_id": 9001}}).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(p))); self.end_headers(); self.wfile.write(p)
srv = HTTPServer(("127.0.0.1", 0), H)
open(sys.argv[2], "w").write(str(srv.server_address[1])); srv.serve_forever()
PYEOF
python3 "$TMP/stub.py" "$REQLOG" "$PORTFILE" & STUB_PID=$!
for _ in $(seq 1 50); do [ -s "$PORTFILE" ] && break; sleep 0.1; done
API="http://127.0.0.1:$(cat "$PORTFILE")"
wedged_case() { # root -> progress dir with a wedged turn (hung reply, real answer in the transcript)
  local s="$1/agents/wa/.claude/channels/telegram" p="$1/agents/wa/.claude/channels/telegram/progress"
  mkdir -p "$p" "$1/store"; printf 'TELEGRAM_BOT_TOKEN=TESTTOKEN\n' > "$s/.env"
  { printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"VALODI_VALASZ"}]}}'
    printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu1","name":"mcp__plugin_telegram_telegram__reply"}]}}'; } > "$s/transcript.jsonl"
  printf '[{"chat_id":"10000000001","message_id":555,"transcript_path":"%s"}]\n' "$s/transcript.jsonl" > "$p/SID.json"
  python3 -c "import os,sys,time; os.utime(sys.argv[1], (time.time()-100,)*2)" "$p/SID.json"
  echo "$p"
}
for MODE in standby normal; do
  R="$TMP/wd-$MODE"; P="$(wedged_case "$R")"; [ "$MODE" = standby ] && : > "$R/store/.standby"
  : > "$REQLOG"
  OUT="$(HOME="$TMP" MARVEEN_ROOT="$R" TELEGRAM_API_BASE="$API" TELEGRAM_WATCHDOG_FORCE_AGENT_UP=1 TELEGRAM_WATCHDOG_WEDGED_UP_SEC=1 python3 "$REPO/scripts/hooks/telegram_progress_watchdog.py" 2>&1)"
  REQS="$(grep -c . "$REQLOG")"; STATE=no; [ -f "$P/SID.json" ] && STATE=yes
  if [ "$MODE" = standby ]; then
    assert_eq "watchdog standby: says [standby]" "yes" "$(has '[standby]' "$OUT")"
    assert_eq "watchdog standby: 0 Bot API requests" "0" "$REQS"
    assert_eq "watchdog standby: the synced progress state is left alone" "yes" "$STATE"
  else
    assert_eq "watchdog normal: delivers the real answer (1 sendMessage)" "1" "$(grep -c '^sendMessage ' "$REQLOG")"
    assert_eq "watchdog normal: the handled state file is removed" "no" "$STATE"
  fi
done

# --- (1c) the Slack watchdog: the same guard decision ---
echo ""
echo "(1c) slack_progress_watchdog.py stops in standby, runs without it"
for MODE in standby normal; do
  R="$TMP/swd-$MODE"; mkdir -p "$R/store" "$R/agents" "$R/.claude"; [ "$MODE" = standby ] && : > "$R/store/.standby"
  OUT="$(HOME="$TMP" MARVEEN_ROOT="$R" python3 "$REPO/scripts/hooks/slack_progress_watchdog.py" 2>&1)"; RC=$?
  assert_eq "slack watchdog $MODE: exit 0" "0" "$RC"
  assert_eq "slack watchdog $MODE: [standby] line" "$([ "$MODE" = standby ] && echo yes || echo no)" "$(has '[standby]' "$OUT")"
done

# --- (2) doctor.sh with a BSD-style padding wc ---
echo ""
echo "(2) doctor.sh reads a padded wc count as a number"
REAL_WC="$(command -v wc)"
printf '#!/bin/bash\nn="$(%s "$@")"; set -- $n; printf "%%8s" "$1"; shift; [ $# -gt 0 ] && printf " %%s" "$@"; echo\n' "$REAL_WC" > "$SHIM/wc"; chmod +x "$SHIM/wc"
assert_eq "the wc shim pads like BSD wc" "       0" "$(printf '' | PATH="$SHIM:$PATH" wc -l)"
for MODE in zero two; do
  R="$TMP/doc-$MODE"; H="$R/home"; mkdir -p "$R/scripts" "$R/store" "$H/.claude/skills/synced"; cp "$REPO/scripts/doctor.sh" "$R/scripts/"
  [ "$MODE" = two ] && mkdir -p "$H/.claude/skills/a-copy" "$H/.claude/skills/b-copy"
  OUT="$(HOME="$H" WEB_PORT=1 PATH="$SHIM:$PATH" FAKE_UNAME=Linux "$SYS_BASH" "$R/scripts/doctor.sh" 2>&1 | sed -E 's/\x1b\[[0-9;]*m//g')"
  if [ "$MODE" = zero ]; then
    assert_eq "doctor, 0 global copies + padded wc: OK line" "yes" "$(has '✓ nincs globalis ~/.claude/skills masolat' "$OUT")"
    assert_eq "doctor, 0 agent copies + padded wc: OK line" "yes" "$(has '✓ nincs agens-szintu skill-masolat' "$OUT")"
    assert_eq "doctor, padded wc: no false 'masolat' failure" "no" "$(has 'skill-masolat a ~/.claude/skills alatt' "$OUT")"
  else
    assert_eq "doctor, 2 global copies: still a failure, with the bare number" "yes" "$(has '✗ 2 globalis skill-masolat' "$OUT")"
  fi
done

echo ""
echo "standby-watchdog-and-doctor-wc: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
