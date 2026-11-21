#!/usr/bin/env bash
# FORKDEPLOY1121: the one-press deploy's executor (src/web/fork-deploy-approval.ts starts it, DETACHED, after the owner
# approved a fork_deploy request). It runs in its own process group, so launchd's kickstart -k of the dashboard does not
# stop it (measured 2026-11-21 with a throwaway launchd job: the detached child lived on, a same-group control died).
#
# Order, chosen so that a failure leaves the fork and the install apart as rarely as possible:
#   1. every precondition again, fresh: the install on <branch> at FROM with a clean tracked tree, <remote>/<branch> and
#      every mirror's <branch> at FROM, TO's only parent FROM;
#   2. the install fast-forwards to TO, npm ci when package-lock.json changed, npm run build (stamps dist/.built-commit);
#   3. a backup of store/claudeclaw.db (sqlite's backup API; the last 3 are kept);
#   4. push TO to <remote>/<branch>, then to each mirror (fast-forward only, never forced);
#   5. a RESTART marker in store/dashboard.log, the restart, and a wait for the NEW dashboard's boot stamp
#      (store/fork-deploy/boot.json: built_commit TO, started after the restart) and HTTP 200 on its port.
# A failure before the push: the install goes back to FROM (reset --keep, npm ci, build), nothing is restarted and
# nothing left the machine. A failure after the restart: the install goes back to FROM and is restarted again; the fork
# then stays on TO and the report says so. Every stage is written to store/fork-deploy/<id>.json (fixed words, SHAs,
# remote names only); the dashboard reports the final one. Only when no dashboard answers at the end does this script
# send the owner a Telegram line itself (scripts/notify.sh).
#
# Usage: fork-deploy.sh <approval-id> <from-sha> <to-sha> <remote> <mirrors,csv> <branch> <service-label> <port> <lock 0|1>
# Test hooks (the dashboard removes both from the environment it starts this with):
#   FORK_DEPLOY_RESTART_CMD      replaces the launchctl kickstart
#   FORK_DEPLOY_HEALTH_TIMEOUT_S replaces the 120 s wait
set -u

ID="${1:-}"; FROM="${2:-}"; TO="${3:-}"; REMOTE="${4:-}"; MIRRORS_CSV="${5:-}"; BRANCH="${6:-}"; LABEL="${7:-}"; PORT="${8:-}"; LOCK="${9:-}"
INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GIT=/usr/bin/git
[ -x "$GIT" ] || GIT=git

die_usage() { echo "fork-deploy.sh: $1" >&2; exit 2; }
[[ "$ID" =~ ^[0-9a-f-]{36}$ ]] || die_usage "bad approval id"
[[ "$FROM" =~ ^[0-9a-f]{40}$ ]] || die_usage "bad from sha"
[[ "$TO" =~ ^[0-9a-f]{40}$ ]] || die_usage "bad to sha"
[[ "$REMOTE" =~ ^[A-Za-z0-9_-]{1,64}$ ]] || die_usage "bad remote"
[[ -z "$MIRRORS_CSV" || "$MIRRORS_CSV" =~ ^[A-Za-z0-9_-]{1,64}(,[A-Za-z0-9_-]{1,64})*$ ]] || die_usage "bad mirrors"
[[ "$BRANCH" =~ ^[A-Za-z0-9_-]{1,64}$ ]] || die_usage "bad branch"
[[ "$LABEL" =~ ^[A-Za-z0-9._-]{1,128}$ ]] || die_usage "bad service label"
[[ "$PORT" =~ ^[0-9]{1,5}$ ]] || die_usage "bad port"
[[ "$LOCK" = 0 || "$LOCK" = 1 ]] || die_usage "bad lock flag"

DIR="$INSTALL_DIR/store/fork-deploy"
mkdir -p "$DIR" || exit 3
STAGE_FILE="$DIR/$ID.json"
LOG="$DIR/$ID.log"
BOOT_FILE="$DIR/boot.json"
exec >>"$LOG" 2>&1
cd "$INSTALL_DIR" || exit 3

IFS=',' read -r -a MIRRORS <<< "$MIRRORS_CSV"
MIRRORS_PUSHED=""
MIRRORS_FAILED=""
HEALTH_TIMEOUT="${FORK_DEPLOY_HEALTH_TIMEOUT_S:-120}"
[[ "$HEALTH_TIMEOUT" =~ ^[0-9]{1,4}$ ]] || HEALTH_TIMEOUT=120

log() { echo "[$(date '+%Y-%m-%dT%H:%M:%S%z')] $*"; }

# stage <name> [final result reason]: every value is a fixed word, a SHA or a remote name, so plain printf is JSON.
stage() {
  local name="$1" final="${2:-false}" result="${3:-}" reason="${4:-}"
  local prod fork
  prod="$("$GIT" rev-parse HEAD 2>/dev/null || true)"
  fork="$(remote_main "$REMOTE")"
  local tmp="$STAGE_FILE.tmp.$$"
  {
    printf '{"approval_id":"%s","stage":"%s","final":%s' "$ID" "$name" "$final"
    [ -n "$result" ] && printf ',"result":"%s"' "$result"
    [ -n "$reason" ] && printf ',"reason":"%s"' "$reason"
    printf ',"from":"%s","to":"%s","prod":"%s","fork":"%s"' "$FROM" "$TO" "$prod" "$fork"
    printf ',"mirrors_pushed":"%s","mirrors_failed":"%s","at":%s}\n' "$MIRRORS_PUSHED" "$MIRRORS_FAILED" "$(date +%s)"
  } > "$tmp" && mv -f "$tmp" "$STAGE_FILE"
  log "stage=$name final=$final result=$result reason=$reason prod=$prod fork=$fork"
}

remote_main() {
  "$GIT" ls-remote "$1" "refs/heads/$BRANCH" 2>/dev/null | awk '{print $1; exit}'
}

finish() { stage "$1" true "$2" "$3"; exit 0; }

notify_owner() {
  # Only when no dashboard can report: a fixed text, no SHA longer than 8.
  bash "$INSTALL_DIR/scripts/notify.sh" "$1" >/dev/null 2>&1 || log "notify.sh failed"
}

rebuild() {
  if [ "$LOCK" = 1 ]; then
    npm ci --no-audit --no-fund || return 1
  fi
  npm run build || return 1
  [ "$(cat dist/.built-commit 2>/dev/null)" = "$("$GIT" rev-parse HEAD)" ] || return 1
}

# Back to FROM before anything was restarted: nothing left the machine unless the caller says so.
rollback_local() {
  local reason="$1"
  log "rollback to $FROM ($reason)"
  if "$GIT" reset --keep "$FROM" && rebuild; then
    finish failed failed "$reason"
  fi
  stage rollback_failed true rollback_failed "$reason"
  notify_owner "Elesites ${TO:0:8}: HIBA ($reason), es a visszaallas sem sikerult. A futo vezerlopult meg a regi kodot tartja, de a dist serult lehet: NE inditsd ujra kezi ellenorzes nelkul. Naplo: store/fork-deploy/$ID.log"
  exit 1
}

# wait_health <sha> <restart-epoch>: the boot stamp of a dashboard started after the restart, built from <sha>, and 200.
wait_health() {
  local want="$1" since="$2" deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
  while [ "$(date +%s)" -le "$deadline" ]; do
    if [ -f "$BOOT_FILE" ]; then
      local built started
      built="$(sed -n 's/.*"built_commit":"\([0-9a-f]*\)".*/\1/p' "$BOOT_FILE")"
      started="$(sed -n 's/.*"started_at":\([0-9]*\).*/\1/p' "$BOOT_FILE")"
      if [ "$built" = "$want" ] && [ -n "$started" ] && [ "$started" -ge "$since" ]; then
        local code
        code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$PORT/" || true)"
        [ "$code" = 200 ] && return 0
      fi
    fi
    sleep 2
  done
  return 1
}

restart_dashboard() {
  echo "--- RESTART $(date '+%Y-%m-%dT%H:%M:%S%z') fork-deploy ${FROM:0:8}..${TO:0:8} ($1) ---" >> "$INSTALL_DIR/store/dashboard.log"
  if [ -n "${FORK_DEPLOY_RESTART_CMD:-}" ]; then
    bash -c "$FORK_DEPLOY_RESTART_CMD"
  else
    launchctl kickstart -k "gui/$(id -u)/$LABEL"
  fi
}

log "fork-deploy $ID: $FROM -> $TO ($REMOTE, mirrors: ${MIRRORS_CSV:-none}, branch $BRANCH, lock $LOCK)"
stage started

# 1. preconditions, fresh
[ "$("$GIT" rev-parse --abbrev-ref HEAD 2>/dev/null)" = "$BRANCH" ] || finish failed failed precheck_not_on_branch
[ "$("$GIT" rev-parse HEAD 2>/dev/null)" = "$FROM" ] || finish failed failed precheck_install_moved
[ -z "$("$GIT" status --porcelain --untracked-files=no 2>/dev/null)" ] || finish failed failed precheck_install_dirty
[ "$(remote_main "$REMOTE")" = "$FROM" ] || finish failed failed precheck_fork_moved
for m in "${MIRRORS[@]}"; do
  [ "$(remote_main "$m")" = "$FROM" ] || finish failed failed precheck_mirror_moved
done
"$GIT" fetch --no-tags --quiet "$REMOTE" "$TO" || finish failed failed precheck_fetch_failed
[ "$("$GIT" rev-list --parents -n 1 "$TO" 2>/dev/null)" = "$TO $FROM" ] || finish failed failed precheck_not_one_commit
stage prechecked

# 2. the install moves to TO and builds
"$GIT" merge --ff-only "$TO" || finish failed failed merge_failed
stage merged
if [ "$LOCK" = 1 ]; then
  npm ci --no-audit --no-fund || rollback_local npm_ci_failed
fi
npm run build || rollback_local build_failed
[ "$(cat dist/.built-commit 2>/dev/null)" = "$TO" ] || rollback_local build_stamp_mismatch
stage built

# 3. a backup of the database before the new code starts on it
BACKUP_DIR="$INSTALL_DIR/store/backups"
mkdir -p "$BACKUP_DIR" || rollback_local backup_failed
BACKUP="$BACKUP_DIR/fork-deploy-${FROM:0:8}-$(date +%Y%m%d-%H%M%S).db"
python3 -I -c '
import sqlite3, sys
src = sqlite3.connect(sys.argv[1]); dst = sqlite3.connect(sys.argv[2])
src.backup(dst); dst.close(); src.close()
chk = sqlite3.connect(sys.argv[2]); ok = chk.execute("pragma integrity_check").fetchone()[0]; chk.close()
sys.exit(0 if ok == "ok" else 1)
' "$INSTALL_DIR/store/claudeclaw.db" "$BACKUP" || rollback_local backup_failed
# keep the last 3 of this script's own backups
ls -1t "$BACKUP_DIR"/fork-deploy-*.db 2>/dev/null | tail -n +4 | while IFS= read -r old; do rm -f -- "$old"; done
stage backed_up

# 4. push: the fork first (a refusal here means nothing left the machine), then the mirrors
"$GIT" push "$REMOTE" "$TO:refs/heads/$BRANCH" || rollback_local push_failed
[ "$(remote_main "$REMOTE")" = "$TO" ] || rollback_local push_not_visible
for m in "${MIRRORS[@]}"; do
  if "$GIT" push "$m" "$TO:refs/heads/$BRANCH" && [ "$(remote_main "$m")" = "$TO" ]; then
    MIRRORS_PUSHED="${MIRRORS_PUSHED:+$MIRRORS_PUSHED,}$m"
  else
    MIRRORS_FAILED="${MIRRORS_FAILED:+$MIRRORS_FAILED,}$m"
  fi
done
stage pushed

# 5. restart and wait for the new dashboard
SINCE="$(date +%s)"
stage restarting
restart_dashboard deploy || log "restart command returned non-zero"
if wait_health "$TO" "$SINCE"; then
  finish deployed deployed ""
fi

log "health check failed for $TO; going back to $FROM"
if "$GIT" reset --keep "$FROM" && rebuild; then
  SINCE="$(date +%s)"
  stage rolling_back
  restart_dashboard rollback || log "rollback restart command returned non-zero"
  if wait_health "$FROM" "$SINCE"; then
    finish rolled_back rolled_back health_failed
  fi
fi
stage rollback_failed true rollback_failed health_failed
notify_owner "Elesites ${TO:0:8}: az uj vezerlopult nem indult el, es a visszaallas utan sem valaszol. A fork main mar ${TO:0:8}. Kezi beavatkozas kell. Naplo: store/fork-deploy/$ID.log"
exit 1
