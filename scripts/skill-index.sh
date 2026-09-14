#!/bin/bash
# Skill Index Generator (Level 0: name + description only, keeps token use low)
#
# SKILLSGIT914: there is ONE skills tree -- <repo>/.claude/skills, a nested
# clone of the private marveen-skills repository. Claude Code reads project
# skills from the cwd upward to the git root, so this tree is what every agent
# sees; the former global (~/.claude/skills) and per-agent copies are gone,
# because the copies drifted (CRLF-broken scripts, five skills with three
# different bodies). This script therefore indexes exactly that one tree.
#
# Usage: skill-index.sh            -> <repo>/.claude/skills/.skill-index.md
#        skill-index.sh <AGENT_DIR> -> accepted for backward compatibility,
#                                      prints a deprecation note, indexes the
#                                      same single tree (no agent-level index).
# A leiras-rovidites python3-at hasznal (karakter-szintu vagas, lasd lentebb).
# Ha hianyzik, ALLJUNK MEG hangosan: enelkul minden leiras "(nincs leiras)" lenne,
# es az index csendben hasznalhatatlanna valna -- pontosan az a nema hiba, amit
# 2026-09-07-en javitottunk.
command -v python3 >/dev/null 2>&1 || {
  echo "skill-index: python3 kell a leirasok karakter-szintu rovideteséhez, de nincs a PATH-on" >&2
  exit 1
}
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILLS_DIR="$ROOT/.claude/skills"
OUTPUT="$SKILLS_DIR/.skill-index.md"
if [ $# -ge 1 ]; then
  echo "skill-index: az AGENT_DIR argumentum elavult (SKILLSGIT914): egyetlen fa van, $SKILLS_DIR -- azt indexelem" >&2
fi
if [ ! -d "$SKILLS_DIR" ]; then
  echo "skill-index: nincs skills fa itt: $SKILLS_DIR (klonozd: scripts/skills-sync.sh)" >&2
  exit 1
fi
echo "# Skill Index (Level 0)" > "$OUTPUT"
echo "" >> "$OUTPUT"
echo "Ez a flotta EGYETLEN skill-fajanak indexe ($SKILLS_DIR, git: marveen-skills). Csak a nevet és leírást tartalmazza (Level 0)." >> "$OUTPUT"
echo "Ha egy skill releváns, olvasd be a teljes SKILL.md-t (Level 1)." >> "$OUTPUT"
echo "Ha segédfájlokra is szükség van, nézd meg a scripts/ és references/ mappákat (Level 2)." >> "$OUTPUT"
echo "" >> "$OUTPUT"
echo "| Skill | Leírás |" >> "$OUTPUT"
echo "|-------|--------|" >> "$OUTPUT"
SKILL_COUNT=0

index_skills_dir() {
  local dir="$1"
  local scope="$2"  # unused since SKILLSGIT914 (single tree); kept for call-site compatibility
  for skill_dir in "$dir"/*/; do
    [ -d "$skill_dir" ] || continue
    local skill_md="$skill_dir/SKILL.md"
    [ -f "$skill_md" ] || continue

    local name
    # tr -d '\r': ket globalis SKILL.md CRLF-es (2026-09-07-en merve) -- CR nelkul
    # az index CRLF-es lesz, es a sorvegek elrontjak a tablazatot.
    name=$(grep -m1 "^name:" "$skill_md" 2>/dev/null | sed 's/^name: *//' | tr -d '"' | tr -d "'" | tr -d '\r')
    if [ -z "$name" ]; then
      name=$(basename "$skill_dir")
    fi

    local desc
    # NE `cut -c1-120`: a GNU cut BAJTOKAT vag, nem karaktereket, ezert egy ekezetes
    # karakter kozepen elvag, a fajl ervenytelen UTF-8 lesz, es a grep onnantol
    # BINARISKENT kezeli -- nema talalat, exit 1, nulla hibauzenet. 2026-09-07-en
    # pontosan ez tortent: az index "Non-ISO extended-ASCII"-va valt, es a heartbeat
    # "keress meglevo skillt szoveges keresessel" lepese csendben semmit nem talalt.
    # A python3 karakter-szinten vag (a telepito fuggosege, mindig van).
    desc=$(grep -m1 "^description:" "$skill_md" 2>/dev/null | sed 's/^description: *//' | tr -d '"' | tr -d "'" | tr -d '\r' \
      | python3 -c 'import sys; s=sys.stdin.readline().rstrip("\n"); print(s[:120])')
    if [ -z "$desc" ]; then
      desc="(nincs leírás)"
    fi
      echo "| \`$name\` | $desc |" >> "$OUTPUT"
    SKILL_COUNT=$((SKILL_COUNT + 1))
  done
}

index_skills_dir "$SKILLS_DIR" "global"


echo "" >> "$OUTPUT"
echo "_${SKILL_COUNT} skill indexelve. Generálva: $(date '+%Y-%m-%d %H:%M')_" >> "$OUTPUT"

# --- ONELLENORZES ---------------------------------------------------------
# Pont azt a nema hibat fogja meg, ami 2026-09-07-en tortent: az index letrejott,
# a szkript zoldet mondott, es kozben a grep BINARISKENT kezelte a fajlt (egyetlen
# ervenytelen UTF-8 bajt miatt), tehat a heartbeat skill-keresese csendben semmit
# nem talalt. A hibanak ITT kell elbuknia, ne harom retteggel arrebb.
# python3-mal validalunk, nem iconv-val: a python3 a telepito fuggosege, az iconv nem.
python3 - "$OUTPUT" <<'VALIDATE' || exit 1
import sys
p = sys.argv[1]
raw = open(p, 'rb').read()
try:
    text = raw.decode('utf-8')
except UnicodeDecodeError as e:
    print(f"skill-index: az index NEM ervenyes UTF-8 ({e}) -- a grep binariskent kezelne, "
          f"es a skill-kereses csendben semmit nem talalna", file=sys.stderr)
    sys.exit(1)
if b'\r' in raw:
    print("skill-index: CR van az indexben (CRLF) -- valamelyik SKILL.md Windows-sorvegu", file=sys.stderr)
    sys.exit(1)
VALIDATE

# Merged futasnal: ha vannak agens-skillek a lemezen, KELL agens sor is az indexben.
# Enelkul egy csendben global-only index atmenne az UTF-8 ellenorzesen.

echo "Skill index generated: $OUTPUT ($SKILL_COUNT skills)"
