#!/usr/bin/env bash
# firebase-mcp inditasa a Marveen flottahoz.
#
# MIERT KELL EZ A WRAPPER
#   A @gannonh/firebase-mcp csomag egy FAJL-UTVONALAT var
#   (SERVICE_ACCOUNT_KEY_PATH), nem nyers env-erteket. A Vault viszont csak
#   env-erteket tud feloldani (lasd scripts/vault-env-wrapper.sh), ezert ez a
#   szkript maga oldja fel a titkot, es ir belole egy 600-as ideiglenes
#   fajlt induláskor -- a nyers kulcs SOSE kerul a .mcp.json-ba vagy configba.
#
# FONTOS
#   Az MCP stdio protokollt hasznal, ezert a stdout-ra SEMMIT nem szabad irni.
#   Minden diagnosztika a stderr-re megy.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SECRET_ID="${FIREBASE_SA_SECRET_ID:-firebase-csomagmegorzo-service-account}"
KEY_FILE="${FIREBASE_SA_KEY_FILE:-$PROJECT_ROOT/store/.firebase-csomagmegorzo-sa.json}"

NODE=""
for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
  if [ -x "$candidate" ]; then NODE="$candidate"; break; fi
done
if [ -z "$NODE" ]; then
  NODE="$(command -v node 2>/dev/null || true)"
fi
if [ -z "$NODE" ]; then
  echo "firebase-mcp-launch: node not found" >&2
  exit 1
fi

RESOLVED="$(printf 'FIREBASE_SA_JSON=%s\n' "$SECRET_ID" | "$NODE" "$PROJECT_ROOT/scripts/vault-resolve.mjs")"
JSON_VALUE="${RESOLVED#FIREBASE_SA_JSON=}"

if [ -z "$JSON_VALUE" ]; then
  echo "firebase-mcp-launch: nem talalhato/ures a '$SECRET_ID' vault-titok." >&2
  exit 1
fi

umask 077
printf '%s' "$JSON_VALUE" > "$KEY_FILE"
chmod 600 "$KEY_FILE"

export SERVICE_ACCOUNT_KEY_PATH="$KEY_FILE"
# A csomagmegorzo-projekt SZANDEKOSAN nem hasznal Firebase Storage-ot (a
# Spark/ingyenes csomagon fut) -- a fajltarolas Cloudinary-n megy (Peter,
# 2026-08-27). Ezert nincs FIREBASE_STORAGE_BUCKET beallitva: ez EZ a
# helyes allapot, nem hianyzo config. A storage_* toolok emiatt nem fognak
# mukodni ezen a projekten -- ha kesobb mas Firebase-projekthez kell
# Storage, ott allitsd be kulon.
[ -n "${FIREBASE_STORAGE_BUCKET:-}" ] && export FIREBASE_STORAGE_BUCKET

exec npx -y @gannonh/firebase-mcp
