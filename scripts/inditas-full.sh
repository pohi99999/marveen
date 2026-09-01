#!/bin/bash
# Robust one-shot launcher for the Marveen dashboard + channels, meant to be
# called from the Windows start.bat. Idempotent: safe to run when things are
# already up. Prints the final dashboard URL (with token) as the LAST line of
# stdout so the caller can grab it.
set -u
cd /home/pohi/marveen || exit 1

http_code() {
  curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://127.0.0.1:3420 2>/dev/null
}

if [ "$(http_code)" != "200" ]; then
  echo "[inditas] dashboard down, launching..." >&2
  tmux kill-session -t marveen-dashboard 2>/dev/null
  tmux new-session -d -s marveen-dashboard "node dist/index.js >> store/dashboard.log 2>&1"
  for i in $(seq 1 20); do
    sleep 1
    [ "$(http_code)" = "200" ] && break
  done
fi

if ! tmux has-session -t marveen-channels 2>/dev/null; then
  echo "[inditas] channels down, launching..." >&2
  nohup bash scripts/channels.sh >> store/channels-startbat.log 2>&1 &
  disown
  for i in $(seq 1 15); do
    sleep 1
    tmux has-session -t marveen-channels 2>/dev/null && break
  done
fi

TOKEN="$(grep -o 'http://127.0.0.1:3420[^"]*' store/dashboard.log 2>/dev/null | tail -1 | sed -n 's/.*token=//p')"
if [ -n "$TOKEN" ]; then
  echo "http://127.0.0.1:3420/?token=${TOKEN}"
else
  echo "http://127.0.0.1:3420/"
fi
