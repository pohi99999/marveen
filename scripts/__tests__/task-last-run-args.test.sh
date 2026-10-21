#!/bin/bash
# LAUNCHQUOTEREST1008 (SECSZIVEK1007 follow-up): scripts/task-last-run.sh puts
# its arguments into SQL. The task name now goes in as an SQL string literal
# (a quote doubled), and the hours window must be a whole number.
# A throwaway install with its own store/claudeclaw.db; nothing else is touched.
# Run: bash scripts/__tests__/task-last-run-args.test.sh
set -u
PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/scripts" "$TMP/store"
cp "$REPO/scripts/task-last-run.sh" "$TMP/scripts/"
# The sqlite3 CLI is not on every machine (measured 2026-10-21: a cloud container
# with python3 but no sqlite3 binary -- every case failed with rc 127 before any
# SQL ran). The real binary is preferred; only when it is missing does a fixture
# shim stand in: the same SQLite engine through python3's stdlib module, covering
# exactly the invocations used here and in task-last-run.sh (`sqlite3 DB SQL`,
# `sqlite3 -header -column DB SQL`, several statements per call). An SQL error is
# exit 1 with "Error:" on stderr, like the real CLI, so a broken query still fails.
if ! command -v sqlite3 >/dev/null 2>&1; then
  mkdir -p "$TMP/bin"
  cat > "$TMP/bin/sqlite3" <<'SHIM'
#!/usr/bin/env python3
import sqlite3, sys
args = sys.argv[1:]
header = False
while args and args[0].startswith("-"):
    opt = args.pop(0)
    if opt == "-header": header = True
    elif opt == "-column": pass
    else: sys.exit("sqlite3 shim: unsupported option %s" % opt)
db, sql = args
con = sqlite3.connect(db)
buf, stmts = "", []
for piece in sql.split(";"):
    buf += piece + ";"
    if sqlite3.complete_statement(buf):
        stmts.append(buf); buf = ""
buf = buf[:-1]  # the ";" added after the last piece
if buf.strip(): stmts.append(buf)
try:
    for st in stmts:
        cur = con.execute(st)
        rows = cur.fetchall()
        if cur.description and (rows or header):
            if header: print("  ".join(d[0] for d in cur.description))
            for r in rows: print("  ".join("" if v is None else str(v) for v in r))
    con.commit()
except sqlite3.Error as e:
    sys.stderr.write("Error: %s\n" % e); sys.exit(1)
SHIM
  chmod +x "$TMP/bin/sqlite3"
  PATH="$TMP/bin:$PATH"
fi
NOW_MS=$(( $(date +%s) * 1000 ))
sqlite3 "$TMP/store/claudeclaw.db" "CREATE TABLE task_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, agent TEXT NOT NULL, ts INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'fired');
  INSERT INTO task_runs(name, agent, ts) VALUES ('it''s a task', 'geri', $NOW_MS), ('plain-task', 'geri', $NOW_MS);"

echo "task-last-run.sh arguments in SQL"
OUT="$(bash "$TMP/scripts/task-last-run.sh" "it's a task" 2>&1)"; RC=$?
[ "$RC" = 0 ] && pass "a task name with an apostrophe runs (rc 0)" || fail "a task name with an apostrophe runs (rc $RC: $(printf '%s' "$OUT" | head -2 | tr '\n' ' '))"
printf '%s' "$OUT" | grep -q "fired" && pass "...and finds its row" || fail "...and finds its row (out: $(printf '%s' "$OUT" | head -3 | tr '\n' ' '))"
OUT="$(bash "$TMP/scripts/task-last-run.sh" plain-task 24 2>&1)"; RC=$?
[ "$RC" = 0 ] && printf '%s' "$OUT" | grep -q fired && pass "a plain name with a whole-number window works as before" || fail "a plain name with a whole-number window works as before (rc $RC)"
bash "$TMP/scripts/task-last-run.sh" plain-task "1 OR 1" >/dev/null 2>&1; RC=$?
[ "$RC" = 2 ] && pass "a window that is not a whole number is refused (rc 2)" || fail "a window that is not a whole number is refused (rc $RC)"
bash "$TMP/scripts/task-last-run.sh" --stats "24 OR 1" >/dev/null 2>&1; RC=$?
[ "$RC" = 2 ] && pass "--stats refuses the same" || fail "--stats refuses the same (rc $RC)"
[ "$(sqlite3 "$TMP/store/claudeclaw.db" 'SELECT count(*) FROM task_runs')" = 2 ] && pass "the table is untouched" || fail "the table is untouched"
echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
