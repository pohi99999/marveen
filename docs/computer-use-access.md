# Computer Use engedélykérés Telegram-gombbal

Ha egy session meghívja a `mcp__computer-use__request_access`-t, a Claude Code a terminálban dialógust nyit ("Computer Use wants to control these apps"). Telegram-only üzemben ott senki nem ül, a csatorna közben áll. Korábban a dashboard menüfigyelője kb. 45 mp után Escape-pel zárta, ami a dialógusban elutasítást jelent (2026-10-22 22:02:58).

Most a dashboard (`src/web/computer-use-access.ts`) így kezeli:

1. **Felismerés.** A fő sessiont 5 mp-enként, a többit a percenkénti menü-passzban nézi. A felismerő a `pane-state.ts` `parseComputerUseAccessDialog` függvénye. Az applista a tele körös (◉) sorokból jön. Az "Allow for this session (N apps)" gomb N-je ugyanennyi kell legyen, különben a dialógus ismeretlen alakúnak számít.
2. **Kérdés a tulajnak.** Létrejön egy `computer_use_access` kategóriájú jóváhagyás 10 perces lejárattal, és Péter Telegram-üzenetet kap az appokkal és két gombbal: **Engedélyezem** / **Elutasítom**. A várakozás alatt a menüfigyelő nem küld Escape-et erre a dialógusra.
3. **Döntés.** Csak Péter gombja dönthet. Ennél a kategóriánál a döntés kizárólag a patchelt Telegram-plugin `approval-callbacks.jsonl` sorából jöhet, amely a valódi Telegram-frissítés `from.id`-jét és a nonce-ot hordozza. A többi út elutasítja:
   - a `/approvals` szöveges parancs;
   - a `POST /api/approvals/:id/telegram-decision` (ott a `from_id` a hívótól jön);
   - a dashboard `PATCH`-e;
   - a `POST /api/approvals` ilyen kategóriával;
   - a GET-ek a nonce-ot sem adják ki.
4. **Billentyű.**
   - **Engedélyezem:** Le-nyíl, újraolvasás, és Enter csak akkor, ha a fókusz az "Allow for this session" soron áll, és ugyanazok az appok látszanak. Utána ellenőrzi, hogy a dialógus eltűnt.
   - **Elutasítom, vagy 10 perc döntés nélkül:** Escape. Ez a dialógus saját elutasítása, nem vak menü-zárás.
   - **Ha a dialógus közben eltűnt vagy megváltozott:** a kérés lezárul, billentyű nincs.
   - **Ismeretlen alak (például CLI-frissítés után):** billentyű nincs, csak hangos riasztás `tmux attach`-csal.

## Amit nem véd ki

Egy azonos felhasználóként futó folyamat a `approval-callbacks.jsonl`-be is írhat, vagy közvetlenül `tmux send-keys`-t küldhet. Ez a megoldás a természetes, ügynök által használt utakat zárja le (szöveges parancs, API, dashboard), nem a tetszőleges fájlírást.

A channel-coordinator-os telepítéseken (nincs plugin-patch) a gomb a HTTP-útra érkezik, amit ez a kategória elutasít. Ott a kérés 10 perc után elutasítással zárul. A `request_access` alakját a Claude Code 2.1.306 bundle-jéből olvastuk ki. Az első éles dialógus capture-je kerüljön be fixture-nek.
