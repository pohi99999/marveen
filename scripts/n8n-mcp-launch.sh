#!/usr/bin/env bash
# n8n-mcp indito a Marveen flottahoz.
#
# MIERT KELL
#   Az n8n a WINDOWS oldalon fut, a WSL-bol nem localhost-on erheto el, hanem a
#   WSL gateway cimen -- ami ujraindulaskor VALTOZIK. Ezert nem szabad fix IP-t
#   a configba irni: ez a szkript indulaskor deriti ki a mukodo cimet.
#
# FONTOS
#   Az MCP stdio protokollt hasznal, ezert a stdout-ra SEMMIT nem szabad irni.
#   Minden diagnosztika a stderr-re megy.
set -euo pipefail

PORT="${N8N_PORT:-5678}"
KEYFILE="${N8N_KEY_FILE:-/home/pohi/marveen/store/.n8n-api-key}"

_reachable() {
  curl -s -o /dev/null --max-time 3 "http://$1:${PORT}/rest/settings" 2>/dev/null
}

HOST=""
# 1) localhost: ha a WSL mirrored networking be van kapcsolva, ez mukodik
# 2) WSL gateway: a Windows host cime WSL felol
for candidate in 127.0.0.1 "$(ip route show default 2>/dev/null | awk '{print $3; exit}')"; do
  [ -z "$candidate" ] && continue
  if _reachable "$candidate"; then HOST="$candidate"; break; fi
done

if [ -z "$HOST" ]; then
  echo "n8n-mcp-launch: az n8n nem erheto el a ${PORT} porton (sem localhost, sem WSL gateway)." >&2
  echo "n8n-mcp-launch: fut-e az n8n a Windows oldalon?" >&2
  exit 1
fi

export N8N_API_URL="http://${HOST}:${PORT}"

if [ -f "$KEYFILE" ]; then
  export N8N_API_KEY="$(tr -d '[:space:]' < "$KEYFILE")"
else
  echo "n8n-mcp-launch: nincs API kulcs (${KEYFILE}), csak a dokumentacios toolok lesznek elerhetok." >&2
fi

# Az n8n a WSL szamara PRIVAT cimen (localhost vagy a Windows-host gateway) van.
# Az n8n-mcp alapertelmezett SSRF vedelme (strict) a privat IP-ket tiltja, ezert a
# workflow-kezelo hivasok "Private IP addresses not allowed" hibaval bukanak el.
# A permissive mod engedi a localhostot es a privat tartomanyokat. Itt ez a helyes
# beallitas, mert a celpont SZANDEKOSAN a sajat gepen van, nem tavoli szolgaltatas.
export WEBHOOK_SECURITY_MODE="${WEBHOOK_SECURITY_MODE:-permissive}"

export MCP_MODE=stdio
export LOG_LEVEL="${LOG_LEVEL:-error}"
export DISABLE_CONSOLE_OUTPUT=true

exec npx -y n8n-mcp
