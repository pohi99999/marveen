#!/usr/bin/env bash
# revenuecat-mcp inditasa a Marveen flottahoz.
#
# MIERT KELL EZ A WRAPPER
#   A `revenuecat-mcp` csomag `dotenv-safe`-et hasznal, ami FELTETLENUL egy
#   `.env.example` fajlt var a MUNKAKONYVTARBAN (nem a csomag sajat
#   mappajaban!) -- ha nincs ott, ENOENT-tel elszall; ha a marveen sajat
#   `.env.example`-jat latja (mert onnan inditottuk), a marveen-specifikus
#   valtozokat (pl. HEARTBEAT_CALENDAR_ID) hianyolja, semmi koze a
#   RevenueCat-hez. Ezert egy DEDIKALT, ures munkakonyvtarba lepunk at
#   inditas elott, ahol csak a sajat, minimalis .env.example van
#   (store/mcp-workdirs/revenuecat/.env.example).
#
# FONTOS
#   Az MCP stdio protokollt hasznal, ezert a stdout-ra SEMMIT nem szabad irni.
#   Minden diagnosztika a stderr-re megy.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKDIR="$PROJECT_ROOT/store/mcp-workdirs/revenuecat"

cd "$WORKDIR"

exec "$SCRIPT_DIR/vault-env-wrapper.sh" npx -y revenuecat-mcp
