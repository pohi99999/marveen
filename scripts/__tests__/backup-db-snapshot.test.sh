#!/usr/bin/env bash
# backup.sh takes the SQLite databases as sqlite .backup snapshots, not as a
# file copy, and can take extra databases from outside the repo
# (store/backup-extra-db-dirs). Synthetic repo, no network, no real store.
#
# Why: the store/ copy used `cp` on a DB the dashboard is writing, plus its
# -wal/-shm. A cp of a live WAL database is not a consistent snapshot, and a
# stale -wal next to a restored DB is replayed onto it. And the databases of a
# service outside the repo (2026-10-22: the brunella-core data/*.db on the Mac,
# 280 MB, the only copy) were in no backup at all.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/../backup.sh"
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1 -- got '$2', want '$3'"; fail=$((fail+1)); fi; }

if ! command -v sqlite3 >/dev/null 2>&1; then echo "SKIP: no sqlite3 CLI"; exit 0; fi

mkrepo() {
  local t; t="$(mktemp -d "${TMPDIR:-/tmp}/bk-db.XXXXXX")"
  mkdir -p "$t/scripts/lib" "$t/store" "$t/home/.claude/skills/x" "$t/home/.claude/scheduled-tasks/y" "$t/ext"
  echo s > "$t/home/.claude/skills/x/SKILL.md"; echo s > "$t/home/.claude/scheduled-tasks/y/SKILL.md"
  cp "$SRC" "$t/scripts/backup.sh"; cp "$HERE/../lib/archive-list-has.sh" "$t/scripts/lib/"
  # A WAL-mode store DB whose newest rows live ONLY in the -wal: a held-open
  # writer below keeps them out of the main file until the snapshot is taken.
  sqlite3 "$t/store/claudeclaw.db" 'PRAGMA journal_mode=WAL; CREATE TABLE t(x); INSERT INTO t VALUES (1),(2),(3);' >/dev/null
  sqlite3 "$t/ext/side.db" 'PRAGMA journal_mode=WAL; CREATE TABLE s(y); INSERT INTO s VALUES (7),(8);' >/dev/null
  git -C "$t" init -q && git -C "$t" add -A && git -C "$t" -c user.name=t -c user.email=t@t commit -qm init
  echo "$t"
}
run() { ( cd "$1" && HOME="$1/home" BACKUP_DIR="$1/bk" BACKUP_KEEP=3 bash scripts/backup.sh >"$1/out.log" 2>&1 ); echo $?; }
extract() { rm -rf "$1/x" && mkdir -p "$1/x" && tar -xzf "$(ls -1t "$1"/bk/claudeclaw-*.tar.gz | head -1)" -C "$1/x"; }
rows() { sqlite3 "file:$1?mode=ro" "select count(*) from $2" 2>/dev/null || echo ERR; }

# --- 1. store DB: a snapshot carrying the WAL-only rows, no -wal/-shm in the archive
T="$(mkrepo)"
# Rows 4..6 written through a connection that stays open (sleep), so they sit in the -wal.
( printf 'PRAGMA wal_autocheckpoint=0; INSERT INTO t VALUES (4),(5),(6);\n'; sleep 4 ) | sqlite3 "$T/store/claudeclaw.db" & W=$!
sleep 1
check "store DB has a live -wal while backup runs" "$( [ -s "$T/store/claudeclaw.db-wal" ] && echo yes || echo no)" "yes"
check "clean run exits 0" "$(run "$T")" "0"
wait $W 2>/dev/null
extract "$T"
check "archived claudeclaw.db passes integrity_check" "$(sqlite3 "file:$T/x/repo/store/claudeclaw.db?mode=ro" 'pragma integrity_check')" "ok"
check "archived claudeclaw.db holds the WAL-only rows (6)" "$(rows "$T/x/repo/store/claudeclaw.db" t)" "6"
check "no -wal/-shm next to it in the archive" "$(ls "$T/x/repo/store" | grep -cE '\.db-(wal|shm)$')" "0"
check "archived DB is standalone (journal_mode delete)" "$(sqlite3 "file:$T/x/repo/store/claudeclaw.db?mode=ro" 'pragma journal_mode')" "delete"
check "no extra/ group without the config" "$( [ -d "$T/x/extra" ] && echo yes || echo no)" "no"
rm -rf "$T"

# --- 2. extra DB dir from store/backup-extra-db-dirs
T="$(mkrepo)"
printf '# comment line\n\n%s\n' "$T/ext" > "$T/store/backup-extra-db-dirs"
check "run with an extra dir exits 0" "$(run "$T")" "0"
extract "$T"
f="$(find "$T/x/extra" -name side.db 2>/dev/null | head -1)"
check "extra DB is in the archive under extra/" "$( [ -n "$f" ] && echo yes || echo no)" "yes"
check "extra DB passes integrity_check and holds its rows" "$( [ -n "$f" ] && sqlite3 "file:$f?mode=ro" 'pragma integrity_check')/$( [ -n "$f" ] && rows "$f" s)" "ok/2"
check "manifest names the extra DB with its source path" "$(grep -c "^extra/.*/side.db  (from $T/ext/side.db)" "$T/x/MANIFEST.txt")" "1"
check "verification counts the extra entry" "$(grep -c 'verified .* manifest entries' "$T/out.log")" "1"
rm -rf "$T"

# --- 3. an extra "DB" that is not SQLite fails the run loudly (exit 6)
T="$(mkrepo)"
echo "not a database" > "$T/ext/broken.db"
printf '%s\n' "$T/ext" > "$T/store/backup-extra-db-dirs"
check "a non-SQLite extra .db -> exit 6" "$(run "$T")" "6"
check "  ... and says which one" "$(grep -c 'broken.db' "$T/out.log" | awk '{print ($1>0)?"yes":"no"}')" "yes"
rm -rf "$T"

# --- 4. a configured dir that does not exist fails the run (a typo must not pass silently)
T="$(mkrepo)"
printf '%s\n' "$T/nincs-ilyen" > "$T/store/backup-extra-db-dirs"
check "a missing extra dir -> exit 6" "$(run "$T")" "6"
rm -rf "$T"

# --- 5. BACKUP_KEEP retention
T="$(mkrepo)"
for i in 1 2 3 4; do run "$T" >/dev/null; sleep 1; done
check "BACKUP_KEEP=3 keeps three archives" "$(ls -1 "$T"/bk/claudeclaw-*.tar.gz | wc -l | tr -d ' ')" "3"
rm -rf "$T"

# --- 6. a WAL-mode DB with NO -wal/-shm next to it (nobody holds it open)
# 2026-10-23 04:30, the first scheduled run on the Mac: the brunella-core
# checkpoints.db (WAL mode, the service not holding it open, so no sidecars)
# could not be opened through file:...?mode=ro ("unable to open database
# file"): a read-only connection cannot create the -shm a WAL database needs.
# The run failed with exit 6. Measured: deterministic without the sidecars, and
# the Apple sqlite3 keeps them after close, so the cases above never hit it.
# The sidecars are removed explicitly here for that reason.
sha() { shasum -a 256 "$1" 2>/dev/null | awk '{print $1}' || sha256sum "$1" | awk '{print $1}'; }
T="$(mkrepo)"
printf '%s\n' "$T/ext" > "$T/store/backup-extra-db-dirs"
rm -f "$T/ext/side.db-wal" "$T/ext/side.db-shm" "$T/store/claudeclaw.db-wal" "$T/store/claudeclaw.db-shm"
check "WAL-mode extra DB, sidecars gone" "$(sqlite3 "$T/ext/side.db" 'pragma journal_mode' 2>/dev/null; rm -f "$T/ext/side.db-wal" "$T/ext/side.db-shm"; ls "$T/ext" | grep -c -- '-wal\|-shm')" "wal
0"
before="$(sha "$T/ext/side.db")"
check "WAL DBs without sidecars -> exit 0" "$(run "$T")" "0"
extract "$T"
f="$(find "$T/x/extra" -name side.db 2>/dev/null | head -1)"
check "  ... the extra DB is in the archive with its rows" "$( [ -n "$f" ] && sqlite3 "file:$f?mode=ro" 'pragma integrity_check')/$( [ -n "$f" ] && rows "$f" s)" "ok/2"
check "  ... the store DB is in the archive with its rows" "$(rows "$T/x/repo/store/claudeclaw.db" t)" "3"
check "  ... the source DB content is unchanged" "$(sha "$T/ext/side.db")" "$before"
rm -rf "$T"

# --- 7. a failed run names where its details are, and that file exists
T="$(mkrepo)"
echo "not a database" > "$T/ext/broken.db"
printf '%s\n' "$T/ext" > "$T/store/backup-extra-db-dirs"
check "a failing run -> exit 6" "$(run "$T")" "6"
flog="$(ls -1 "$T"/bk/claudeclaw-*.failures.txt 2>/dev/null | head -1)"
check "  ... writes a failure log next to the archive" "$( [ -s "$flog" ] && echo yes || echo no)" "yes"
check "  ... the failure log names the failed item" "$( [ -n "$flog" ] && grep -c 'broken.db' "$flog" | awk '{print ($1>0)?"yes":"no"}')" "yes"
check "  ... the output points at that file (the path the alert uses)" "$( [ -n "$flog" ] && grep -cF "details: $flog" "$T/out.log")" "1"
check "  ... no logs/backup.log claim anywhere" "$(grep -c 'logs/backup.log' "$T/scripts/backup.sh")" "0"
rm -rf "$T"
T="$(mkrepo)"
check "a clean run -> exit 0" "$(run "$T")" "0"
check "  ... writes no failure log" "$(ls -1 "$T"/bk/ | grep -c 'failures')" "0"
rm -rf "$T"

echo "PASS=$pass FAIL=$fail"
[ "$fail" -eq 0 ]
