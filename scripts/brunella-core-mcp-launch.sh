#!/usr/bin/env bash
# brunella-core MCP indito a Marveen (WSL) oldalrol.
#
# MIERT IGY
#   A brunella-core a WINDOWS oldalon fut (F:\mcp-brunella-core), es ott is kell
#   futnia: a node_modules Windows-ra forditott natív modulokat tartalmaz
#   (better-sqlite3), WSL-bol inditva "invalid ELF header"-rel elhasal. Ezen felul
#   a szerver EMBERI logokat ir a stdout-ra, ami az MCP stdio protokollt eleve
#   hasznalhatatlanna teszi. Ezert NEM stdio-kent kotjuk be, hanem a szerver sajat
#   /sse MCP-vegpontjan keresztul, egy mcp-remote hiddal.
#
#   A Windows host cime WSL-bol a default route gateway-e, ami UJRAINDULASKOR
#   VALTOZIK -- ezert nincs fix IP a configban, ez a szkript deriti ki futasidoben.
#
# FONTOS
#   MCP stdio: a stdout-ra SEMMIT nem szabad irni, minden diagnosztika stderr-re megy.
set -euo pipefail

PORT="${BRUNELLA_CORE_PORT:-3000}"
KEYFILE="${BRUNELLA_CORE_KEY_FILE:-/home/pohi/marveen/store/.brunella-core-api-key}"

_reachable() {
  curl -s -o /dev/null --max-time 3 "http://$1:${PORT}/" 2>/dev/null
}

HOST=""
# 1) localhost: ha a WSL mirrored networking be van kapcsolva, ez mukodik
# 2) WSL gateway: a Windows host cime WSL felol
for candidate in 127.0.0.1 "$(ip route show default 2>/dev/null | awk '{print $3; exit}')"; do
  [ -z "$candidate" ] && continue
  if _reachable "$candidate"; then HOST="$candidate"; break; fi
done

if [ -z "$HOST" ]; then
  echo "brunella-core-mcp-launch: a brunella-core nem erheto el a ${PORT} porton" >&2
  echo "brunella-core-mcp-launch: fut-e a szerver a Windows oldalon (F:\\mcp-brunella-core)?" >&2
  exit 1
fi

if [ ! -f "$KEYFILE" ]; then
  echo "brunella-core-mcp-launch: nincs API kulcs (${KEYFILE})." >&2
  echo "brunella-core-mcp-launch: a szerver /sse vegpontja operator-hozzaferest ker (BRUNELLA_API_KEY)." >&2
  exit 1
fi
KEY="$(tr -d '[:space:]' < "$KEYFILE")"

# X-API-Key es nem "Authorization: Bearer ..." -- a kulcs-ertekben nincs szokoz,
# igy nem futunk bele az mcp-remote --header szokoz-kezelesi hibajaba.
# --allow-http: a celpont a SAJAT gep (WSL gateway / localhost), nem tavoli
# szolgaltatas, ezert a plaintext HTTP itt nem hoz uj kockazatot. Nelkule az
# mcp-remote elutasitja a nem-HTTPS URL-t.
exec npx -y mcp-remote@0.8.3 "http://${HOST}:${PORT}/sse" \
  --transport sse-only \
  --allow-http \
  --header "X-API-Key:${KEY}"
