---
name: projekt-figyelo
description: Napi projekt-allapot attekintes a kulso projekt-mappakon (externalProjectPaths) es az Obsidian "Projektek MOC"-on. Memoria-frissites mindig, Telegram jelzes csak erdemi talalatnal.
---

# Napi projekt-figyelő

## Mikor fut

Reggel 08:00 (cron `0 8 * * *`), a fő ágensnek ({{MAIN_AGENT_ID}}).

## Cél

Hogy a főágens mindig tudja, melyik projekt hogy áll, anélkül hogy a
felhasználó kézzel karbantartott tudásbázisát (Obsidian) felülírná vagy
minden nap újraírná. Ez adja a "folyamatos tanulás" képességet a meglévő
hibrid memóriára ülve rá — nincs külön adatbázis hozzá.

## Eljárás

1. **Hivatalos lista beolvasása**: az Obsidian vault `00_MOC/Projektek MOC.md`
   jegyzete (`obsidian-vault` vagy `obsidian-search` MCP) — ez a kézzel
   karbantartott, mérvadó projektlista kategóriákkal és státusszal.

2. **Külső mappák átfésülése**: `store/dashboard-settings.json`
   `externalProjectPaths` mezője adja a figyelt gyökér-mappákat. Nézd meg,
   van-e olyan projekt-mappa, ami NINCS benne a MOC-ban.

3. **Aktivitás-ellenőrzés**: a MOC "Aktív fejlesztés alatt" szekciójából 2-3
   projektet nézz meg közelebbről (fájl-módosítási idők, ha elérhető git log)
   — történt-e érdemi új munka a legutóbbi futás óta?

4. **Memória-mentés (MINDIG)**: amit találtál, mentsd `warm`-tier memóriaként
   (`agent_id: {{MAIN_AGENT_ID}}`), projektenként tömören:
   ```bash
   curl -s -X POST http://localhost:3420/api/memories \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer $(cat {{INSTALL_DIR}}/store/.dashboard-token)" \
     -d '{"agent_id":"{{MAIN_AGENT_ID}}","content":"MIT","category":"warm","keywords":"projekt-neve"}'
   ```

5. **Telegram CSAK erdemi talalatnal**: ha van olyan projekt-mappa, ami nincs
   a MOC-ban, VAGY egy "aktív" projekt hetek óta láthatóan nem mozdult, küldj
   EGY tömör Telegram-üzenetet {{OWNER_NAME}}-nek. Ha nincs újdonság, ne írj
   semmit — ez heartbeat típus, csendben maradj.

## Buktatók

- **SOHA ne írd felül vagy szerkeszd automatikusan a `Projektek MOC.md`
  táblázatait.** Az a felhasználó kézzel karbantartott jegyzete (lásd a saját
  "Karbantartás" szekcióját a MOC alján) — ha frissítést javasolnál, azt a
  Telegram-üzenetben javasold, ne a fájlban hajtsd végre.
- Ne pingelj minden nap, csak ha ténylegesen van új infó — ellenkező esetben
  a felhasználó elkezdi figyelmen kívül hagyni a jelzéseket.
- Ne végezz teljes, mély auditot minden projekten minden nap (drága és
  felesleges) — elég 2-3 aktív projekt gyors átnézése rotálva.

## Ellenőrzés

- A memória-mentés sikeres (200-as válasz).
- Telegram-üzenet csak akkor ment ki, ha ténylegesen volt érdemi találat.
