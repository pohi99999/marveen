# Marveen — Útmutató

> Ez a fájl a te személyes, lépésről lépésre útmutatód a Marveen telepítéséhez, beállításához és napi használatához. A projekt saját, részletes dokumentációja a [`docs/`](docs/README.md) mappában van — ez az útmutató arra épít, és a te konkrét (Windows + WSL) helyzetedre szabva vezet végig mindenen.

## Mi ez a projekt?

A **Marveen** egy Claude Code-ra épülő, önfejlesztő AI-asszisztens keretrendszer. Nem egyszerű chatbot: egy vagy több AI-ágens ("csapat"), amelyek Telegramon vagy Slacken kommunikálnak veled, önállóan dolgoznak a háttérben (Heartbeat), emlékeznek a korábbi beszélgetésekre (réteges memória-rendszer), és egy webes Mission Control dashboardon (`http://localhost:3420`) kezelhetők.

Technikailag: TypeScript/Node.js alkalmazás, SQLite adatbázissal (FTS5 + vektor-keresés), a `@anthropic-ai/claude-agent-sdk` csomagra építve. Windows alatt WSL (Ubuntu) alá települ, mert a Claude Code CLI és a natív modulok (pl. `better-sqlite3`) Linux környezetet igényelnek.

> **Megjegyzés:** ha korábban láttál egy "Brunella Agent System" leírást (Ollama, AnythingLLM, Python `myai/` alrendszer) — az egy **másik** projektre vonatkozik, nem erre. Ez az útmutató a tényleges Marveen kódra épül.

---

## 1. Jelenlegi állapot a gépeden

Amikor ellenőriztem, a telepítés **nem futott le sikeresen**, bár a terminálban úgy tűnt, végigment. Két hibát találtam és javítottam:

1. **`install-windows.ps1` szintaktikai hiba** (308. sor): egy PowerShell string helytelenül escape-elt idézőjelet tartalmazott (`\"` helyett `` `" `` kellett volna), ez megzavarta a teljes fájl értelmezését. **Javítva** a lokális repóban (`Z:\001_Workspace\Marveen\marveen\install-windows.ps1`), de ez a javítás egyelőre nincs commitolva/push-olva a GitHub-ra.
2. **Hiányos önálló letöltés**: a `cd ~ && curl -fsSL .../install-linux.sh -o install.sh && bash install.sh` parancs (amit a PS1-hiba miatt manuálisan futtattál) csak egyetlen fájlt tölt le, de az a 27. sorban egy másik fájlra (`install-lang.sh`) hivatkozik, ami emiatt hiányzott — a script azonnal elszállt, mielőtt bármit telepített volna.

**Javítás, amit már elvégeztem:** teljes repót klónoztam natív WSL útvonalra:
```
~/marveen   (WSL-en belül, NEM a Z:\ meghajtóról — lásd miért lent)
```
Itt már megvan az `install-lang.sh` is, tehát a telepítő innen hibátlanul el tud indulni. **A tényleges telepítő futtatása (2. lépéstől lejjebb) még hátravan** — azt neked kell elindítanod, mert személyes hitelesítő adatokat kér (Claude Code bejelentkezés, Telegram bot token), amit nem tudok/nem szabad helyetted automatikusan beírni.

> **Miért WSL-en belül és nem a `Z:\` meghajtóról?** A telepítő maga is figyelmezet erre: Windows-fájlrendszerről (`/mnt/z/...`) futtatva az `npm`/`node` lassú és fájlfigyelési (file-watch) problémákat okozhat. Ezért natív `~/marveen` útvonalra települ, nem a Z:\ meghajtóra.

---

## 2. A telepítés befejezése

Nyiss egy **WSL Ubuntu terminált** (Start menü → Ubuntu, vagy `wsl` parancs egy PowerShell/Terminal ablakban), és futtasd:

```bash
cd ~/marveen
./install-linux.sh
```

Ez végigvezet a következő lépéseken:

1. **Függőségek ellenőrzése/telepítése** — Node.js 20+, git, build-essential, stb.
2. **Claude Code bejelentkezés** — böngészőn keresztüli OAuth login (kell hozzá Claude Max/Pro előfizetés). WSL-ben ez általában megnyit egy linket, amit a Windows böngésződben kell megnyitnod.
3. **Telegram bot létrehozása** — a telepítő elmagyarázza, hogyan kérj tokent a @BotFather-től, és beírod a promptba.
4. **Személyes beállítások** — a bot neve és (opcionálisan) a márkanév (`BOT_NAME` / `BRAND_NAME` — lásd 4. pont lent).
5. **Szolgáltatások indítása** — a dashboard és a csatorna-híd elindul.

A telepítés végén a script kiírja a dashboard címét: **http://localhost:3420**

### Ha elakad

- Ha a script menet közben hibát dob, a `bash install-linux.sh` kimenete pontosan megmondja, melyik lépésnél és miért. Másold ki nekem a hibaüzenetet, és megnézem.
- Ha végigment, de valami nem működik, futtasd a beépített diagnosztikát:
  ```bash
  cd ~/marveen
  bash scripts/doctor.sh
  ```
  Ez ellenőrzi a systemd szolgáltatásokat, tmux session-öket és a portot, és zöld ✓ / piros ✗ jelzéssel mondja meg, mi nem OK.

A gépeden a WSL-ben a **systemd engedélyezve van és fut** (`/etc/wsl.conf` → `[boot] systemd=true`) — ez jó hír, mert így a Marveen `systemd --user` szolgáltatásként indul (`marveen-dashboard`, `marveen-channels`), nem pedig kézi háttérfolyamatként. Ez azt jelenti, hogy a szolgáltatás túléli a terminál bezárását.

> **Fontos tudnivaló:** ahhoz, hogy a `systemd --user` szolgáltatások WSL-újraindítás vagy kijelentkezés után is fussanak (ne csak amíg van nyitva egy WSL ablak), érdemes engedélyezni a "lingering"-et:
> ```bash
> sudo loginctl enable-linger $USER
> ```
> Enélkül előfordulhat, hogy a Marveen leáll, ha bezársz minden WSL-ablakot.

---

## 3. Napi használat

### Dashboard (Mission Control)

Nyisd meg böngészőben: **http://localhost:3420**

Itt kezelhető minden: ágensek, kanban tábla, memória, ütemezések, beállítások, vault (titkok), föderáció.

### Indítás / leállítás / státusz

```bash
cd ~/marveen
./scripts/start.sh     # elindítja a dashboardot + csatorna-hidat
./scripts/stop.sh      # leállítja
bash scripts/doctor.sh # health-check — mi fut, mi nem
```

Ha systemd fut (a te esetedben igen), közvetlenül is vezérelheted:
```bash
systemctl --user status marveen-dashboard marveen-channels
systemctl --user restart marveen-dashboard
journalctl --user -u marveen-dashboard -f   # élő log
```

### Kommunikáció a botoddal

A telepítés során létrehozott Telegram bottal egyszerűen írj neki — a Marveen válaszol. Csatorna-váltáshoz (Slack-re) vagy Slack hozzáadásához lásd a [docs/channels.md](docs/channels.md) leírást, illetve a README "Csatorna" szakaszát.

---

## 4. Konfiguráció

A fő konfigurációs fájl a projekt gyökerében: **`~/marveen/.env`** (a telepítő hozza létre, `.env.example` alapján). A legfontosabb kulcsok:

| Kulcs | Mire való |
|---|---|
| `TELEGRAM_BOT_TOKEN` | A @BotFather-től kapott token |
| `ALLOWED_CHAT_ID` | Kinek a Telegram chat ID-ja írhat a botnak |
| `OWNER_NAME` | A te neved (személyre szabáshoz) |
| `WEB_PORT` | Dashboard portja (alapértelmezett: 3420) |
| `BOT_NAME` / `BRAND_NAME` | Márkázás — az ágens és a termék neve (ha eltérnek) |
| `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` | Csak headless/szerver futtatáshoz kell kézzel; interaktív login után nem |
| `DEFAULT_AGENT_MODEL` | Új ágensek alapértelmezett modellje |
| `AUTO_UPDATE_ENABLED` | `1`-re állítva automatikus szerdai frissítés |

A **legtöbb beállítást nem kell kézzel szerkesztened** — a dashboard bal oldali "Beállítások" menüpontja böngészőből engedi módosítani ezeket (Kanban, Rendszer, Heartbeat csoportokban), mentés/visszaállítás gombokkal. Némelyik változás azonnali, némelyik újraindítást igényel (ezt a felület jelzi).

Teljes referencia: [docs/config-reference.md](docs/config-reference.md)

---

## 5. Ágensek (csapattagok) hozzáadása

A dashboard "Csapat" oldalán vehetsz fel új ágenst. Minden ágensnek saját Telegram botja, saját személyisége (`SOUL.md`), saját utasításai (`CLAUDE.md`) és saját memóriája van — **egy bot tokent nem lehet két ágens közt megosztani**.

Lépések röviden (részletek: [docs/onboarding-uj-asszisztens.md](docs/onboarding-uj-asszisztens.md)):
1. Új bot létrehozása @BotFather-nél (`/newbot`)
2. Ágens felvétele a dashboardon ("Felvétel")
3. A bot token beillesztése az ágens csatorna-beállításánál
4. A használó megnyitja a botot, ír neki, te jóváhagyod a párosítást a dashboardon

---

## 6. Frissítés

```bash
cd ~/marveen
./update.sh
```

Ez `git pull` + build + szolgáltatás-újraindítás + health-check, hiba esetén automatikus rollback-kel. Ha az `AUTO_UPDATE_ENABLED=1` be van állítva, ez automatikusan lefut minden szerdán 04:00-kor.

---

## 7. Hibaelhárítás

| Tünet | Teendő |
|---|---|
| A dashboard nem töltődik be | `bash scripts/doctor.sh` — nézd meg, fut-e a `marveen-dashboard` szolgáltatás |
| A bot nem válaszol | `systemctl --user status marveen-channels`, majd `journalctl --user -u marveen-channels -n 50` |
| WSL-ből induló PowerShell telepítő megszakad | Fuss neki közvetlenül WSL-ből (lásd 2. pont), kerüld a `.ps1` wrappert |
| "install-lang.sh: No such file" hiba | Ne egyetlen fájlt tölts le curl-lal — klónozd a teljes repót (`git clone --branch main https://github.com/Szotasz/marveen.git`) |
| Szolgáltatás leáll, ha bezárod a WSL ablakot | Engedélyezd a lingering-et: `sudo loginctl enable-linger $USER` |
| Build hiba `better-sqlite3` körül | Ne `bun`-nal futtasd — a `start.sh` külön ellenőrzi, hogy valódi `node` fusson, mert a `better-sqlite3` nem támogatott bun alatt |

További, funkciónkénti leírások: [docs/README.md](docs/README.md)

---

## 8. Amit érdemes tudnod a mai munkáról

- A `Z:\001_Workspace\Marveen\marveen\install-windows.ps1` fájlban lévő szintaktikai hibát javítottam, de **ez a javítás még nincs commitolva**. Ha szeretnéd, hogy a következő Windows-telepítés is hibátlanul fusson (neked vagy másnak), szólj, és commitolom/push-olom.
- A WSL oldalon (`~/marveen`) most egy friss, helyesen klónozott checkout van, amiből a `./install-linux.sh` hibátlanul el tud indulni — ezt még végig kell vinned (2. pont).
- A `.bash_history`-ban több API-kulcs és token szerepel plain textben (pl. egy OpenAI kulcs bekerült a `.bashrc`-be is). Érdemes ezeket átnézned és lecserélned/rotálnod, ha még aktívak — shell historyban tárolt kulcsok biztonsági kockázatot jelentenek.
