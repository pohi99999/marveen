# Skillek git-forrásból (SKILLSGIT914)

Mérve 2026-09-14, kártya 37647f9c, Péter jóváhagyásával.

## Elrendezés

- **Egyetlen fa:** `<repo>/.claude/skills` = a PRIVÁT `pohi99999/marveen-skills` repo
  nested klónja. A marveen `.gitignore` `.claude/*` szabálya kizárja, ezért a publikus
  forkba semmi nem kerül belőle, `.gitmodules` sincs.
- **Miért látja minden ügynök:** a Claude Code a munkakönyvtártól felfelé a git-gyökérig
  olvassa a projekt-skilleket; az `agents/<név>` cwd-ből is ezt a fát kapja (bizonyíték:
  a gyökér skilljei az agents/kenshin session-listájában).
- **Megszűnt rétegek:** `~/.claude/skills` (globális másolat) és `agents/<név>/.claude/skills`
  (ügynök-szintű másolat). A kiválasztást a skill `description`-je végzi. A `seed-skills/`
  mappa az upstream-kompatibilitás miatt marad a repóban, de nem használjuk.
- **Sorvégek:** a skills-repo `.gitattributes` `eol=lf` -- a CRLF-tört shebang-szkript
  csapda a fában nem fordulhat elő.
- **Titkok:** a skills-repo pre-commit hookja a marveen `scripts/secret-gate.ts --staged`
  gate-jét futtatja.

## Műveletek

| Mit | Hogyan |
|---|---|
| frissítés | `scripts/skills-sync.sh` (fetch + ff-only + index); az `update.sh` és az `inditas-full.sh` hívja |
| új / javított skill | a fába írod, majd `git -C .claude/skills add -A && git commit && git push` (commit után azonnal push) |
| index | `scripts/skill-index.sh` -> `.claude/skills/.skill-index.md` (egy index, nincs ügynök-index) |
| ellenőrzés | `scripts/doctor.sh` "Skills (git-forrás)" szakasz: checkout, rev-list 0/0, CRLF 0, globális 0, ügynök-szintű 0, index friss |
| Windows (Z:) | ugyanez a klón a Z-checkout `.claude/skills` helyén; frissítés `git pull --ff-only` |

## Migráció (2026-09-14)

seed-skills 23 + gyökér 57 + 9 host-saját + 4 ügynök-saját = 93 skill, secret-gate PASS 135
fájlon az első commit előtt; a régi gyökér-fa és a `~/.claude/skills` egy hétig backupban
(`.claude/skills.bak-pre-gitsource-*`, `~/.claude/skills.bak-*`), utána törlés.
