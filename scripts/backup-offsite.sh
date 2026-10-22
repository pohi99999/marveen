#!/usr/bin/env bash
# Off-machine copy of the newest backup archive (scripts/backup.sh output).
#
# The nightly archive lives on the same disk as everything it backs up; a dead
# disk takes both. This copies the newest backups/claudeclaw-*.tar.gz to a
# second machine, proves the copy by comparing sha256 on the far side, and
# keeps the newest KEEP_REMOTE archives there.
#
# Config: store/backup-offsite.conf, KEY=VALUE lines, PARSED (never sourced):
#   TARGET=user@host:/abs/path    remote (rsync over ssh), or /abs/path (local)
#   SSH=ssh -i ~/.ssh/key -p 2222 the ssh command for a remote TARGET (optional)
#   KEEP_REMOTE=8                 archives kept on the far side (default 8)
#   MAX_AGE_HOURS=36              the newest local archive must be younger
# No config file: a no-op (exit 0), so the seeded weekly task is harmless on an
# install that has not chosen a target.
#
# The archive carries live secrets (see backup.sh). The target must be a
# machine the owner controls, not a cloud-sync folder.
#
# Exit: 0 ok / not configured, 2 bad config, 3 no archive, 4 newest archive too
# old, 5 copy or verification failed.
set -euo pipefail
umask 077

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-${REPO_ROOT}/backups}"
CONF="${BACKUP_OFFSITE_CONF:-${REPO_ROOT}/store/backup-offsite.conf}"

fail() {  # fail <exit code> <message>: say it, queue it for the main agent, exit
  echo "backup-offsite: FAILED: $2" >&2
  if [[ -x "${REPO_ROOT}/scripts/agent-msg.sh" ]]; then
    local mid="marveen"
    if [[ -f "${REPO_ROOT}/.env" ]]; then
      local _m
      _m="$(grep -E '^[[:space:]]*MAIN_AGENT_ID[[:space:]]*=' "${REPO_ROOT}/.env" | tail -1 \
        | sed -E 's/^[^=]*=[[:space:]]*//; s/[[:space:]]*$//; s/^"(.*)"$/\1/; s/^'\''(.*)'\''$/\1/' || true)"
      [[ -n "${_m}" ]] && mid="${_m}"
    fi
    bash "${REPO_ROOT}/scripts/agent-msg.sh" "${mid}" "${mid}" \
      "[MENTES] A heti kulso mentes-masolat ELBUKOTT: $2" >/dev/null 2>&1 || true
  fi
  exit "$1"
}

if [[ ! -f "${CONF}" ]]; then
  echo "backup-offsite: not configured (${CONF} is missing) -- nothing to do"
  exit 0
fi

conf_get() {  # conf_get KEY: the last KEY= line, value trimmed
  { grep -E "^[[:space:]]*$1[[:space:]]*=" "${CONF}" || true; } | tail -1 \
    | sed -E 's/^[^=]*=[[:space:]]*//; s/[[:space:]]*$//'
}
TARGET="$(conf_get TARGET)"
SSH_CMD="$(conf_get SSH)"; SSH_CMD="${SSH_CMD:-ssh -o BatchMode=yes}"
KEEP_REMOTE="$(conf_get KEEP_REMOTE)"; KEEP_REMOTE="${KEEP_REMOTE:-8}"
MAX_AGE_HOURS="$(conf_get MAX_AGE_HOURS)"; MAX_AGE_HOURS="${MAX_AGE_HOURS:-36}"

# Every value reaches a shell on one side or the other, so each is held to a
# plain shape; anything else is refused before a single command runs.
SAFE_PATH='^(/|~/)[A-Za-z0-9._/~-]*$'
if [[ "${TARGET}" == *:* ]]; then
  R_HOST="${TARGET%%:*}"; R_PATH="${TARGET#*:}"
  [[ "${R_HOST}" =~ ^[A-Za-z0-9._@-]+$ ]] || fail 2 "TARGET host is not a plain user@host: ${R_HOST}"
else
  R_HOST=""; R_PATH="${TARGET}"
fi
[[ -n "${R_PATH}" && "${R_PATH}" =~ ${SAFE_PATH} ]] || fail 2 "TARGET path must be absolute and plain ([A-Za-z0-9._/~-]): ${R_PATH}"
[[ "${KEEP_REMOTE}" =~ ^[1-9][0-9]*$ ]] || fail 2 "KEEP_REMOTE must be a positive integer: ${KEEP_REMOTE}"
[[ "${MAX_AGE_HOURS}" =~ ^[1-9][0-9]*$ ]] || fail 2 "MAX_AGE_HOURS must be a positive integer: ${MAX_AGE_HOURS}"
[[ "${SSH_CMD}" =~ ^[A-Za-z0-9._/~=@[:space:]-]+$ ]] || fail 2 "SSH holds characters outside [A-Za-z0-9._/~=@ -]"

NEWEST="$(ls -1t "${BACKUP_DIR}"/claudeclaw-*.tar.gz 2>/dev/null | head -1 || true)"
[[ -n "${NEWEST}" ]] || fail 3 "no archive in ${BACKUP_DIR} (is the nightly backup running?)"
NAME="$(basename "${NEWEST}")"
# GNU first: GNU `stat -f` means --file-system and prints a filesystem report
# to stdout before it fails, so a BSD-first fallback captured that report on
# Linux. BSD `stat -c` fails with nothing on stdout.
MTIME="$(stat -c %Y "${NEWEST}" 2>/dev/null || stat -f %m "${NEWEST}")"
AGE_H=$(( ( $(date +%s) - MTIME ) / 3600 ))
[[ "${AGE_H}" -lt "${MAX_AGE_HOURS}" ]] || fail 4 "the newest archive ${NAME} is ${AGE_H} h old (limit ${MAX_AGE_HOURS} h): the nightly backup is not producing"

sha_local() { (sha256sum "$1" 2>/dev/null || shasum -a 256 "$1") | awk '{print $1}'; }
WANT="$(sha_local "${NEWEST}")"

# The far-side commands: the same script text for a local and a remote target.
# R_PATH is quoted with single quotes, safe because SAFE_PATH admits none.
REMOTE_SHA="cd '${R_PATH}' && { sha256sum '${NAME}' 2>/dev/null || shasum -a 256 '${NAME}'; } | awk '{print \$1}'"
REMOTE_PRUNE="cd '${R_PATH}' && ls -1t claudeclaw-*.tar.gz 2>/dev/null | tail -n +$((KEEP_REMOTE + 1)) | while IFS= read -r f; do rm -f -- \"\$f\" && echo \"pruned \$f\"; done"
if [[ -n "${R_HOST}" ]]; then
  # shellcheck disable=SC2086 # SSH_CMD is a validated command line, split on purpose
  far() { ${SSH_CMD} "${R_HOST}" "$1"; }
  far "mkdir -p '${R_PATH}' && chmod 700 '${R_PATH}'" || fail 5 "cannot create ${R_PATH} on ${R_HOST}"
  rsync -a -e "${SSH_CMD}" "${NEWEST}" "${R_HOST}:${R_PATH}/" || fail 5 "rsync of ${NAME} to ${TARGET} failed"
else
  far() { bash -c "$1"; }
  mkdir -p "${R_PATH}" && chmod 700 "${R_PATH}"
  cp -p "${NEWEST}" "${R_PATH}/" || fail 5 "copy of ${NAME} to ${R_PATH} failed"
fi

GOT="$(far "${REMOTE_SHA}" || true)"
[[ "${GOT}" = "${WANT}" ]] || fail 5 "sha256 of ${NAME} on the far side does not match (local ${WANT:0:12}, far ${GOT:0:12})"
echo "backup-offsite: ${NAME} -> ${TARGET}, verified sha256 ${WANT:0:12} on the far side"

far "${REMOTE_PRUNE}" | sed 's/^/backup-offsite: /' || echo "backup-offsite: WARN the far-side prune failed (the copy itself is verified)" >&2
