#!/usr/bin/env bash
# Self-test for the push gate, on a throwaway repo + bare remote (never the
# live checkout). Measures BOTH directions: the allowed push goes through,
# the --no-verify commit is blocked, foreign (already-remote) commits and
# merge commits need no proof, the bypass is loud, attest repairs a rebase.
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@x GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@x
export MARVEEN_PROD_COMMIT_OK=1 SKIP_SECRET_GATE=1   # not under test here
pass=0; fail=0
ok()   { echo "  ok   $1"; pass=$((pass+1)); }
bad()  { echo "  FAIL $1"; fail=$((fail+1)); }

git init -q --bare "$TMP/remote.git"
git init -q "$TMP/repo" && cd "$TMP/repo"
git config commit.gpgsign false
mkdir -p scripts && cp "$SRC/scripts/hook-proof.mjs" "$SRC/scripts/install-hook-proof-hook.sh" "$SRC/scripts/install-git-guard-hook.sh" "$SRC/scripts/install-secret-gate-hook.sh" scripts/
echo base > base.txt && git add -A && git commit -q -m "base (before hooks)"
git remote add origin "$TMP/remote.git" && git push -q origin HEAD:main && git branch -q --set-upstream-to=origin/main
bash scripts/install-hook-proof-hook.sh >/dev/null
# the secret-gate installer wrote a hook that needs npx; replace it with a stub so only the proof logic is measured
printf '#!/usr/bin/env bash\nexit 0\n' > .git/hooks/pre-commit.d/10-secret-gate

# 1. normal commit -> proof recorded -> push passes
echo a > a.txt && git add a.txt && git commit -q -m "normal commit"
if node scripts/hook-proof.mjs status | grep -q "proof (pre-commit)"; then ok "normal commit has proof"; else bad "normal commit has no proof"; fi
if git push -q origin HEAD:main 2>"$TMP/err"; then ok "push with proof passes"; else bad "push with proof was blocked: $(cat "$TMP/err")"; fi

# 2. --no-verify commit -> no proof -> push BLOCKED, loudly
echo b > b.txt && git add b.txt && git commit -q --no-verify -m "sneaky commit"
if git push -q origin HEAD:main 2>"$TMP/err"; then bad "push of --no-verify commit was NOT blocked"; else
  if grep -q "BLOCKED: outgoing commit(s) without pre-commit proof" "$TMP/err" && grep -q "sneaky commit" "$TMP/err"; then ok "push of --no-verify commit blocked, names the commit"; else bad "blocked but message wrong: $(cat "$TMP/err")"; fi
fi

# 3. bypass is loud and lets it through
if MARVEEN_PUSH_PROOF_SKIP=1 git push -q origin HEAD:main 2>"$TMP/err"; then
  if grep -q "MARVEEN_PUSH_PROOF_SKIP=1" "$TMP/err"; then ok "bypass passes and says so"; else bad "bypass silent"; fi
else bad "bypass did not pass"; fi

# 4. foreign commit (made elsewhere, fetched) needs no proof; a new local proofed commit on top passes
git clone -q -b main "$TMP/remote.git" "$TMP/other" && (cd "$TMP/other" && git config commit.gpgsign false && echo c > c.txt && git add c.txt && git commit -q -m "foreign commit" && git push -q origin HEAD:main)
git pull -q --ff-only origin main
echo d > d.txt && git add d.txt && git commit -q -m "local after foreign"
if git push -q origin HEAD:main 2>"$TMP/err"; then ok "foreign commit exempt, proofed local commit passes"; else bad "foreign commit blocked the push: $(cat "$TMP/err")"; fi

# 5. merge commit exempt (git merge runs no pre-commit)
git checkout -q -b feature && echo e > e.txt && git add e.txt && git commit -q -m "feature work" && git checkout -q - 
git merge -q --no-ff -m "merge feature" feature
if git push -q origin HEAD:main 2>"$TMP/err"; then ok "merge commit exempt, merged proofed commit passes"; else bad "merge blocked: $(cat "$TMP/err")"; fi

# 6. rebase rewrites the sha -> proof lost -> blocked; attest repairs it on the record
echo f > f.txt && git add f.txt && git commit -q -m "to be rebased"
GIT_SEQUENCE_EDITOR=: git rebase -q -i HEAD~1 --exec 'true' >/dev/null 2>&1 || true
git commit -q --amend --no-verify -m "to be rebased (rewritten)"
if git push -q origin HEAD:main 2>"$TMP/err"; then bad "rewritten commit NOT blocked"; else ok "rewritten commit blocked"; fi
node scripts/hook-proof.mjs attest HEAD~1..HEAD 2>"$TMP/err"
if grep -q "manual-attest" "$TMP/err" && git push -q origin HEAD:main 2>/dev/null; then ok "attest is loud and unblocks"; else bad "attest failed: $(cat "$TMP/err")"; fi

# 7. node missing -> fail-closed (the sub-hook, not the gate logic)
if PATH=/nonexistent /bin/bash .git/hooks/pre-push.d/20-hook-proof </dev/null 2>"$TMP/err"; then bad "without node the hook passed"; else
  if grep -q "fail-closed" "$TMP/err"; then ok "without node the hook fails closed"; else bad "without node: wrong message"; fi; fi

echo "hook-proof selftest: $pass ok, $fail fail"
[ "$fail" -eq 0 ]
