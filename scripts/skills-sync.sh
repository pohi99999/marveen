#!/usr/bin/env bash
# SKILLSGIT914 -- keep the fleet's single skills tree current.
#
# The tree is .claude/skills at the repo root: a nested clone of the PRIVATE
# pohi99999/marveen-skills repository (the marveen fork is public, and the
# skills carry client-specific operational knowledge, so they cannot live in
# this repo). Claude Code reads project skills from the cwd upward to the git
# root, so this one tree is visible to every agent -- there is no global
# ~/.claude/skills copy and no per-agent copy any more (card 37647f9c).
#
# Exit codes: 0 = current or brought current (or offline: local tree kept),
# 2 = the tree is not a git checkout (nothing to sync; say so loudly).
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
D="$ROOT/.claude/skills"
if [ ! -d "$D/.git" ]; then
  echo "skills-sync: $D nem git-checkout. Klonozd: git clone https://github.com/pohi99999/marveen-skills.git $D" >&2
  exit 2
fi
if ! timeout 20 git -C "$D" fetch -q origin main 2>/dev/null; then
  echo "skills-sync: fetch sikertelen (offline?) -- a helyi fa marad, index frissul" >&2
else
  behind="$(git -C "$D" rev-list --count HEAD..origin/main)"
  ahead="$(git -C "$D" rev-list --count origin/main..HEAD)"
  if [ "$ahead" != "0" ]; then
    echo "skills-sync: FIGYELEM, $ahead helyi skills-commit nincs pusholva (AGENT.md 2/A: commit utan azonnal push)" >&2
  fi
  if [ "$behind" != "0" ]; then
    if git -C "$D" merge -q --ff-only origin/main; then
      echo "skills-sync: $behind commit behuzva ($(git -C "$D" rev-parse --short HEAD))"
    else
      echo "skills-sync: ff-only merge sikertelen (helyi elteres?) -- nezd: git -C $D status" >&2
    fi
  else
    echo "skills-sync: naprakesz ($(git -C "$D" rev-parse --short HEAD))"
  fi
fi
bash "$ROOT/scripts/skill-index.sh"
