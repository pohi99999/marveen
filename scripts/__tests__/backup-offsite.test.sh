#!/usr/bin/env bash
# backup-offsite.sh copies the newest backup archive off the machine, proves the
# copy by sha256 on the far side, and keeps a bounded number there. Hermetic: a
# local target directory stands in for the remote one (TARGET without host:).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/../backup-offsite.sh"
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1 -- got '$2', want '$3'"; fail=$((fail+1)); fi; }

mk() {
  local t; t="$(mktemp -d "${TMPDIR:-/tmp}/bk-off.XXXXXX")"
  mkdir -p "$t/scripts" "$t/store" "$t/backups" "$t/far"
  cp "$SRC" "$t/scripts/backup-offsite.sh"
  echo "$t"
}
arch() { head -c 2048 /dev/urandom > "$1/backups/claudeclaw-$2.tar.gz"; touch -t "$3" "$1/backups/claudeclaw-$2.tar.gz"; }
run() { ( cd "$1" && bash scripts/backup-offsite.sh >"$1/out.log" 2>&1 ); echo $?; }
sha() { (sha256sum "$1" 2>/dev/null || shasum -a 256 "$1") | awk '{print $1}'; }
NOW="$(date +%Y%m%d%H%M)"

# 1. no config: a no-op, exit 0, and it says so
T="$(mk)"; arch "$T" 20261022-040000 "$NOW"
check "no config -> exit 0" "$(run "$T")" "0"
check "  ... says it is not configured" "$(grep -c 'not configured' "$T/out.log")" "1"
check "  ... copied nothing" "$(ls "$T/far" | wc -l | tr -d ' ')" "0"
rm -rf "$T"

# 2. configured: the newest archive lands, sha256 verified on the far side
T="$(mk)"; arch "$T" 20261020-040000 "$(date -v-2d +%Y%m%d%H%M 2>/dev/null || date -d '-2 day' +%Y%m%d%H%M)"; arch "$T" 20261022-040000 "$NOW"
printf 'TARGET=%s\nKEEP_REMOTE=2\n' "$T/far" > "$T/store/backup-offsite.conf"
check "configured -> exit 0" "$(run "$T")" "0"
check "the NEWEST archive is on the far side" "$(ls "$T/far")" "claudeclaw-20261022-040000.tar.gz"
check "  ... with the same sha256" "$(sha "$T/far/claudeclaw-20261022-040000.tar.gz")" "$(sha "$T/backups/claudeclaw-20261022-040000.tar.gz")"
check "  ... and the run says verified" "$(grep -c 'verified sha256' "$T/out.log")" "1"
rm -rf "$T"

# 3. remote retention: KEEP_REMOTE=2 keeps the two newest copies there
T="$(mk)"; printf 'TARGET=%s\nKEEP_REMOTE=2\n' "$T/far" > "$T/store/backup-offsite.conf"
for d in 20261001 20261008 20261015; do head -c 64 /dev/urandom > "$T/far/claudeclaw-$d-040000.tar.gz"; touch -t "${d}0400" "$T/far/claudeclaw-$d-040000.tar.gz"; done
echo keep > "$T/far/not-a-backup.txt"
arch "$T" 20261022-040000 "$NOW"
run "$T" >/dev/null
check "KEEP_REMOTE=2 leaves two archives" "$(ls "$T/far" | grep -c '^claudeclaw-.*\.tar\.gz$')" "2"
check "  ... the newest two" "$(ls "$T/far" | grep '^claudeclaw-' | sort | tr '\n' ' ')" "claudeclaw-20261015-040000.tar.gz claudeclaw-20261022-040000.tar.gz "
check "  ... and touches nothing else there" "$( [ -f "$T/far/not-a-backup.txt" ] && echo kept || echo gone)" "kept"
rm -rf "$T"

# 4. the newest local archive is stale (the nightly job is not running): fail loudly
T="$(mk)"; arch "$T" 20261001-040000 "$(date -v-5d +%Y%m%d%H%M 2>/dev/null || date -d '-5 day' +%Y%m%d%H%M)"
printf 'TARGET=%s\n' "$T/far" > "$T/store/backup-offsite.conf"
check "a 5-day-old newest archive -> exit 4" "$(run "$T")" "4"
rm -rf "$T"

# 5. no archive at all -> exit 3
T="$(mk)"; printf 'TARGET=%s\n' "$T/far" > "$T/store/backup-offsite.conf"
check "no archive -> exit 3" "$(run "$T")" "3"
rm -rf "$T"

# 6. a TARGET path with shell metacharacters is refused, nothing runs
T="$(mk)"; arch "$T" 20261022-040000 "$NOW"
printf 'TARGET=%s\n' "$T/far;touch $T/pwned" > "$T/store/backup-offsite.conf"
check "a metacharacter TARGET -> exit 2" "$(run "$T")" "2"
check "  ... and no injection" "$( [ -e "$T/pwned" ] && echo yes || echo no)" "no"
rm -rf "$T"

# 7. the config is parsed, never sourced: a command line in it does not run
T="$(mk)"; arch "$T" 20261022-040000 "$NOW"
printf 'TARGET=%s\ntouch %s\n' "$T/far" "$T/sourced" > "$T/store/backup-offsite.conf"
run "$T" >/dev/null
check "the config is not sourced" "$( [ -e "$T/sourced" ] && echo yes || echo no)" "no"
rm -rf "$T"

echo "PASS=$pass FAIL=$fail"
[ "$fail" -eq 0 ]
