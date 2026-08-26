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

1. **Brunella (`marveen`):** Főnök / Koordinátor – Telegram híd (`@BrunellaBossbot`), feladatkiosztás, stratégiai döntéshozatal.
2. **Aura (`aura`):** Kutató – Piackutatás, forráselemzés, versenytárselemzés, mély keresés, szintetizált jelentések.
3. **Kenshin (`kenshin`):** Fejlesztő – Szoftverfejlesztés, kódírás, refaktorálás, code review, TDD, Git műveletek (`Z:\001_Workspace\`).
4. **Iris (`irisz`):** Elemző – Adatmodellezés, SQL/Python szkriptek, táblázatok, riportok, közösségi média és profilépítési analitika.
5. **Nyomozó (`nyomozo`):** Auditor – Döntési naplók, történeti összefüggések, korábbi beszélgetések visszakeresése, konzisztencia.
6. **Zeph (`zeph`):** Kísérletező – Új MCP-k tesztelése, skillek generálása, benchmarking, R&D automatizációk.

---

## 6. Változásnapló

- **2026-08-26 (este)** — A teljes flotta-csapat létrehozva és konfigurálva: **Aura** (Kutató), **Kenshin** (Fejlesztő), **Iris** (Elemző), **Nyomozó** (Auditor), **Zeph** (Kísérletező). Testreszabott `CLAUDE.md`, `SOUL.md`, `.mcp.json` és releváns seed-skillek kiosztva. Obsidian tudásbázis frissítve.
- **2026-08-26 (délután)** — Antigravity CLI (`agy`) flotta-tag integráció implementálva (Task 1–5), 56/56 teszt zöld, élesítve WSL-ben és élőben validálva (Gemini 3.7 Flash válaszolt a flottaüzenetre).
- **2026-08-26 (délután)** — GitHub Copilot CLI (`copilot`) flotta-tag integráció befejezve, cherry-pickelve WSL-be és élőben validálva.
- **2026-08-26 (délelőtt)** — Telegram híd (`@BrunellaBossbot`) aktiválva a hiányzó `bun` runtime telepítésével és kétirányú teszteléssel. Obsidian MCP szerverek bekötve. `start.bat` létrehozva az asztalon.
