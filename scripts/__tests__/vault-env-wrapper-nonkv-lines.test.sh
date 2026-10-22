#!/usr/bin/env bash
# vault-env-wrapper.sh must export only KEY=value lines from vault-resolve's stdout. On the Mac mini (2026-10-22)
# a log line landed there (the Keychain-migration warning of src/web/vault.ts); the wrapper tried to export it,
# failed under set -e, and every vault-backed MCP server died before it started. Both directions:
#   (a) a log line next to the secret: the secret still arrives, the wrapper exits 0, the skip is reported on stderr
#       WITHOUT the line's content;
#   (b) only KEY=value lines: no skip message, the old behaviour.
# The resolver is stubbed, so no vault is touched.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
T="$(mktemp -d "${TMPDIR:-/tmp}/vew-nonkv.XXXXXX")"; trap 'rm -rf "$T"' EXIT
pass=0; fail=0
ok() { echo "PASS $1"; pass=$((pass + 1)); }
bad() { echo "FAIL $1"; fail=$((fail + 1)); }
setup() { # $1: what the stub resolver prints
  rm -rf "$T/scripts"; mkdir -p "$T/scripts"
  cp "$HERE/../vault-env-wrapper.sh" "$T/scripts/"
  printf 'process.stdout.write(%s)\n' "$1" > "$T/scripts/vault-resolve.mjs"
}

# (a) a pino-pretty style log line (with its continuation line) before the secret
setup '"[2026-10-22 16:53:40.957 +0200] WARN (86607): Keychain migration failed, keeping file-based key\n    err: \"spawnSync /usr/bin/security ETIMEDOUT\"\nGOOD_SECRET=fixture-value-1\n"'
out="$(GOOD_SECRET=vault:label bash "$T/scripts/vault-env-wrapper.sh" printenv GOOD_SECRET 2>"$T/err")"; rc=$?
[ "$rc" -eq 0 ] && ok "(a) exit 0 with a log line on the resolver's stdout" || bad "(a) exit $rc (expected 0)"
[ "$out" = "fixture-value-1" ] && ok "(a) the secret still reaches the command" || bad "(a) the command saw '$out'"
grep -q "2 non KEY=value line(s)" "$T/err" && ok "(a) the skip is counted on stderr" || bad "(a) no skip count on stderr: $(cat "$T/err")"
grep -q "Keychain migration" "$T/err" && bad "(a) the skipped line's content was echoed" || ok "(a) the skipped line's content is not echoed"

# (b) only KEY=value lines: unchanged
setup '"A_ONE=x\nB_TWO=y=z\n"'
out="$(A_ONE=vault:a B_TWO=vault:b bash "$T/scripts/vault-env-wrapper.sh" sh -c 'echo "$A_ONE|$B_TWO"' 2>"$T/err")"; rc=$?
[ "$rc" -eq 0 ] && [ "$out" = "x|y=z" ] && ok "(b) plain KEY=value lines export as before" || bad "(b) rc=$rc out='$out'"
[ -s "$T/err" ] && bad "(b) unexpected stderr: $(cat "$T/err")" || ok "(b) no skip message"

echo "PASS=$pass FAIL=$fail"; [ "$fail" -eq 0 ]
