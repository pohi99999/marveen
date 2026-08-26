# AGENT.md — Munka-napló és rendszergazdai jegyzet

> Ez a fájl a Marveen projekten végzett munka **élő, folyamatosan frissítendő** naplója és referenciája. **Minden jövőbeli munkamenetben, amikor bármi változik (kód, konfiguráció, GitHub-beállítás, telepítési állapot), ezt a fájlt is frissíteni kell** — új bejegyzéssel a Változásnaplóban, és a releváns szakasz(ok) frissítésével. Ne csak commit-üzenetben vagy chatben dokumentáld a haladást — itt is rögzítsd.

---

## 1. Projekt-azonosítás és Architektúra

Ez a repó a **Marveen** nevű, multi-agent AI-csapat keretrendszer, amely Claude Code, GitHub Copilot CLI és Antigravity CLI motorokat támogat.
A csapatot **Brunella** (főnök / koordinátor) irányítja.

---

## 2. Két checkout, két szerep

| Hely | Mire való | Megjegyzés |
|---|---|---|
| `Z:\001_Workspace\Marveen\marveen` | **Fejlesztői checkout** (Windows), itt szerkesztjük a kódot, innen commitolunk/pusholunk | Git remote: `origin` és `brunella` |
| WSL `~/marveen` (Ubuntu) | **Futtatási checkout** — a Marveen ténylegesen itt fut (Node.js, tmux, Claude/Copilot/Antigravity CLI) | Éles futási környezet |

### 2/A. Szinkron-fegyelem (KÖTELEZŐ elolvasni git-művelet előtt)

> 2026-08-26-án a két checkout **valódi módon elvált** egymástól: a WSL-ben
> valaki elvégzett egy upstream-szinkront (112 commit) de sosem pusholta, a
> Windows checkout közben külön haladt tovább — mire kiderült, a két ág 24
> illetve 94 (más-más bázisponthoz mérve) egyedi commitban tért el. A
> visszaállítás órákig tartott (dry-run merge, kézi ütközésfeloldás
> AGENT.md-ben és `.claude/settings.json`-ban, hitelesítés-hiány a WSL push
> oldalán). Ez a szakasz azért van, hogy ez ne ismétlődjön meg.

**Alapszabály: minden commit után AZONNAL push, függetlenül attól, melyik
checkoutban dolgoztál.** Ne hagyj commitolt, de nem pusholt állapotot
"majd később" jelszóval — pontosan ez okozta a mai eltérést.

**Remote-nevek FIGYELEM — a két checkoutban FORDÍTOTT az elnevezés:**

| | Windows checkout | WSL checkout |
|---|---|---|
| `pohi99999/marveen` (saját fork) | `origin` | `fork` |
| `Szotasz/marveen` (eredeti upstream) | `upstream` | `origin` |

Git-parancs írása előtt MINDIG ellenőrizd `git remote -v`-vel, melyik nevet
melyik repóra használja az adott checkout — a névazonosság félrevezető.

**Rendszeres upstream-szinkron (elmaradt, ezért torlódott fel a mai eltérés)**:
legalább havonta, EGY checkoutból (mondjuk mindig a Windowsból, hogy
konzisztens legyen):
```bash
git fetch upstream
git merge upstream/main       # vagy upstream/develop, ha azt követjük
git push origin main && git push brunella main
```
Utána a MÁSIK checkoutban: `git fetch <sajat-fork-remote-neve> && git reset --hard <ugyanaz>/main`
— NE `git pull`-t a helyi módosítások miatt, hacsak nem tiszta a `git status`.

**Ellenőrzés eltérés-gyanúnál** (mielőtt bármit pusholnál/merge-elnél):
```bash
git fetch <fork-remote>
git rev-list --left-right --count HEAD...<fork-remote>/main
```
Ha mindkét szám (ahead/behind) nagyobb mint 0, VALÓDI eltérés van — ne
`git push --force`-olj, ne `git reset --hard`-olj vakon, nézd át előbb a
`git log --oneline <fork-remote>/main..HEAD` és a fordított irányú listát is.

**A WSL futtatási checkouton van egy commit-guard** (`MARVEEN_PROD_COMMIT_OK`
env-var nélkül elutasítja a direkt commitot, mert a dashboard élőben ebből a
fájlfából szolgál ki) — ez SZÁNDÉKOS védelem, ne kerüld meg alapértelmezésben.
Jogos használni, ha: (a) a working tree állapotát MÁR ellenőrizted (pl.
dry-run merge-gel), (b) a változás dokumentáltan biztonságos (nincs benne
titok — a `secret-gate` hook ezt külön ellenőrzi), (c) utána AZONNAL pusholsz.

**Ismert hiányosság**: a WSL checkoutnak NINCS beállítva push-hitelesítés
GitHub felé (nincs `gh` CLI, nincs credential helper) — csak fetch/pull megy
hitelesítés nélkül (publikus repó). Ha a WSL-ből kellene pusholni, előbb ezt
kell megoldani (pl. `gh auth login` + `gh auth setup-git`, vagy PAT +
`git config credential.helper store`). Egyelőre a push mindig a Windows
checkoutból megy.

---

## 3. GitHub távoli repók

1. `origin` → **https://github.com/pohi99999/marveen.git** (elsődleges dev fork)
2. `brunella` → **https://github.com/pohi99999/brunella-marveen.git** (projekt repó)
3. `upstream` → **https://github.com/Szotasz/marveen.git** (eredeti upstream)

Minden commitot szinkronban pusholunk mind az `origin`, mind a `brunella` távoli ágakra.

---

## 4. Támogatott AI Motorok (Engines)

1. **Claude Code (`claude`):**
   - Fő koordinátor (Brunella) és a szakosított ügynökök alapértelmezett motorja (`claude-sonnet-5`, `claude-opus-5`).
2. **GitHub Copilot CLI (`copilot`):**
   - Teljesen integrált flotta-tag, `--allow-all-tools --continue --config-dir <dir>` indítással (GPT-5.4 / Claude modellek).
3. **Antigravity CLI (`antigravity`):**
   - Teljesen integrált flotta-tag, `agy --dangerously-skip-permissions --model <model>` indítással (Gemini 3.7 Flash / Pro modellek).

---

## 5. Csapatösszeállítás (Flotta Roster)

Mindenki közvetlenül **Brunellának** jelent (`reportsTo: marveen`) — egységes,
lapos hierarchia, a peer-to-peer üzenetküldés emellett mindenkivel mindenkinek
működik.

1. **Brunella (`marveen`):** Főnök / Koordinátor – Telegram híd (`@BrunellaBossbot`), feladatkiosztás, stratégiai döntéshozatal.
2. **Aura (`aura`):** Kutató – Piackutatás, forráselemzés, versenytárselemzés, mély keresés, szintetizált jelentések.
3. **Kenshin (`kenshin`):** Fejlesztő – Szoftverfejlesztés, kódírás, refaktorálás, code review, TDD, Git műveletek (`Z:\001_Workspace\`).
4. **Iris (`irisz`):** Elemző – Adatmodellezés, SQL/Python szkriptek, táblázatok, riportok, közösségi média és profilépítési analitika.
5. **Nyomozó (`nyomozo`):** Auditor – Döntési naplók, történeti összefüggések, korábbi beszélgetések visszakeresése, konzisztencia.
6. **Zeph (`zeph`):** Kísérletező – Új MCP-k tesztelése, skillek generálása, benchmarking, R&D automatizációk.
7. **Lumen (`lumen`):** Webfejlesztő / Dizájn – UI/UX, frontend fejlesztés, technikai megoldás-választás, Kenshinnel együttműködve design-tól kódig.
8. **Agy (`agy-test`):** Helyettes-koordinátor, Antigravity CLI motoron (`gemini-2.5-flash`). Ha Brunella (Claude motor) nem elérhető, átveszi a koordinációt és delegálást. A belső azonosító (`agy-test`) technikai okokból változatlan — csak a `displayName` "Agy".
9. **Pilot (`copilot-test`):** Harmadlagos tartalék motor, GitHub Copilot CLI-n (GPT-5.4) — ha mind Claude, mind Antigravity elérhetetlen. Belső azonosító változatlan (`copilot-test`), `displayName`: "Pilot".

---

## 6. Változásnapló

- **2026-08-26 (éjszaka, 3. tétel)** — **Heti AI-felderítés bevezetve**: Zeph
  kapott egy heti (hétfő 07:00) `ai-heti-felderites` ütemezett feladatot —
  átfésüli a legújabb releváns Claude/MCP/agent-eszköz fejleményeket a saját
  stackünkhöz mérten, jelentést ír Obsidianba (`02_Areas/AI eszköz-felderítés/`,
  új terület-jegyzet) és shared memóriába, üzen Brunellának. Brunella kapott
  egy párja feladatot (`ai-heti-jelentes`, hétfő 09:00) — szintetizál,
  Telegramon összefoglal Péternek, kanban-kártyát nyit minden "bevezetni"
  javaslatra, és **csak Péter explicit, név szerinti jóváhagyása után**
  végzi el a bevezetést (nem az autonómia-szintes gyors-jóváhagyással). Mindkét
  CLAUDE.md-be (Zeph, Brunella) bekerült a szakasz, és mindkét feladat
  verziókövetett sablonként is elmentve (`seed-scheduled-tasks/ai-heti-*`).
- **2026-08-26 (éjszaka, 2. tétel)** — **Git-checkout eltérés feltárva és javítva**: a
  WSL futtatási checkout 112 elmaradt upstream-szinkron commitot tartalmazott
  sosem pusholva, a Windows fejlesztői checkout közben 24 saját committal haladt
  tovább — a két ág valódi módon elvált. Feloldás: dry-run merge mindkét oldalon
  ütközés-ellenőrzéssel, kézi ütközésfeloldás (`AGENT.md`, `.claude/settings.json`
  — utóbbinál egy elavult, mentetlen helyi módosítás derült ki, biztonságosan
  stash-elve), upstream `secret-gate` hook false-positive-ja (saját teszt-fixture,
  ellenőrizve), majd push mindkét remote-ra Windowsról, WSL ráállítva a végeredményre.
  Új szakasz (2/A) az AGENT.md-ben a jövőbeli szinkron-fegyelemről (push azonnal,
  havi upstream-szinkron, remote-név-táblázat, mikor jogos a prod-commit-guard
  felülbírálása). Részletek: Obsidian `Marveen/2026-08-26-git-checkout-divergence-and-sync-procedure.md`.
- **2026-08-26 (éjszaka)** — Élő audit alapján flotta-optimalizálás: Aura (le volt állva)
  újraindítva; **Agy** (`agy-test`, Antigravity, Brunella helyettese) és **Pilot**
  (`copilot-test`, Copilot, harmadlagos tartalék) formalizálva — displayName +
  teljesen újraírt CLAUDE.md/SOUL.md (Pilot korábban törött placeholder-sablonon futott);
  új specialista **Lumen** (webfejlesztő/dizájn) létrehozva; hierarchia egységesítve
  (mindenki `reportsTo: marveen`); `store/agents-desired.json` crash-recovery lista
  kibővítve a teljes rosterre (előtte csak 3 ügynök volt rajta); napi `projekt-figyelo`
  ütemezett feladat telepítve (+ verziókövetett sablon `seed-scheduled-tasks/`-ban);
  22 aktív projekt felvéve kiválasztható kanban project-tagként. Claude Max-váltás
  (Opus a mélyebb szerepekhez) tudatosan elhalasztva az előfizetés-aktiválásig. Részletek
  és a le nem zárt tételek (marveen-oldali `brunella-remote` MCP-hitelesítés) az Obsidian
  vaultban: `Marveen/2026-08-26-fleet-optimization-agy-pilot-lumen.md`.
- **2026-08-26 (este)** — A teljes flotta-csapat létrehozva és konfigurálva: **Aura** (Kutató), **Kenshin** (Fejlesztő), **Iris** (Elemző), **Nyomozó** (Auditor), **Zeph** (Kísérletező). Testreszabott `CLAUDE.md`, `SOUL.md`, `.mcp.json` és releváns seed-skillek kiosztva. Obsidian tudásbázis frissítve.
- **2026-08-26 (délután)** — Antigravity CLI (`agy`) flotta-tag integráció implementálva (Task 1–5), 56/56 teszt zöld, élesítve WSL-ben és élőben validálva (Gemini 3.7 Flash válaszolt a flottaüzenetre).
- **2026-08-26 (délután)** — GitHub Copilot CLI (`copilot`) flotta-tag integráció befejezve, cherry-pickelve WSL-be és élőben validálva.
- **2026-08-26 (délelőtt)** — Telegram híd (`@BrunellaBossbot`) aktiválva a hiányzó `bun` runtime telepítésével és kétirányú teszteléssel. Obsidian MCP szerverek bekötve. `start.bat` létrehozva az asztalon.
