# Copilot CLI mint valódi flotta-tag — design

**Dátum:** 2026-08-26
**Státusz:** tervezet, felhasználói jóváhagyásra vár

## Cél / használati eset

A felhasználónak GitHub Copilot Pro+ előfizetése van, minden prémium
modellhez hozzáféréssel, és gyakran használja a `copilot` CLI-t saját maga.
Azt szeretné, hogy a Marveen flottában a Claude-alapú `marveen` fő ügynök
mellett legyen egy **második, valódi flotta-tag**, ami a GitHub Copilot
CLI-t futtatja motorként. Fő motiváció: ha elfogy a Claude-kredit / API
keret, kisebb feladatokat át tud adni a Copilot-ügynöknek, hogy a munka ne
álljon meg.

Az Antigravity CLI (`agy`) hasonló integrációja **külön menetben** készül
majd, ugyanezt a mintát követve — ebben a specifikációban nem szerepel.

## Scope (ez a kör)

Bekerül:
- Egy új ügynök felvehető a dashboardon `provider: copilot` jelöléssel.
- Indítás/leállítás/állapot-lekérdezés a dashboardról (`POST
  /api/agents/<name>/start` stb.) — ugyanazok a végpontok, mint egy
  Claude-ügynöknél.
- Inter-agent üzenetküldés működik a fő (Claude) ügynök és a
  Copilot-ügynök között (`POST /api/messages`).
- Kanban-kártya hozzárendelhető a Copilot-ügynökhöz (ez a mechanizmus már
  ügynök-független Marveenben, nem igényel változtatást).
- A Copilot CLI saját, izolált `--config-dir`-t kap (ne ossza meg a
  felhasználó interaktív Copilot CLI session-jét/history-ját a saját,
  helyi használatával).

NEM kerül be (explicit felhasználói döntés):
- Telegram/Slack csatorna-bekötés a Copilot-ügynöknek.
- MCP-szerverek bekötése a Copilot-ügynöknek (a Copilot CLI más
  konfig-formátumot használ: `~/.copilot/mcp-config.json` vagy
  `--additional-mcp-config`, nem a Claude-féle projekt-`.mcp.json`-t —
  ennek az összehangolása külön munka lenne).
- Export/import, remote (ssh) ügynök támogatás Copilot-hoz.
- Model-javaslat (AgentSignals) elemzés Copilot-ügynökökre.

## Amit a felfedezés során megtudtam (2026-08-26-i vizsgálat)

- A `copilot` CLI-nek van non-interaktív/headless felülete, ami sok ponton
  párhuzamba állítható a Claude Code-éval: `--continue` (legutóbbi session
  folytatása), `--resume=<id>`, `--allow-all-tools` (=
  `--dangerously-skip-permissions` megfelelője), `--config-dir` (=
  `CLAUDE_CONFIG_DIR` megfelelője), `-p`/`--print` (egy prompt,
  non-interaktív), `--model`.
- A WSL környezetben már van `~/.copilot` konfig (`session-state`,
  `config.json`) — valószínűleg már be van jelentkezve a felhasználó
  fiókjával, de ezt **élesben, a felhasználó felügyelete mellett kell
  megerősíteni** az implementáció első lépéseként (a saját próba-hívásomat
  a biztonsági rendszerem blokkolta, mert egy önálló, teljes
  eszköz-hozzáférésű AI-ügynök non-interaktív indítása kockázatosnak
  tűnhet kívülről).
- A Marveen ügynök-indító logikája (`src/web/agent-process.ts`,
  `startAgentProcess`) **mélyen Claude Code-specifikus**: CC-verzió
  regressziók workaroundjai, izolált `CLAUDE_CONFIG_DIR` kezelés, fleet
  OAuth token export, "trust this folder" dialógus előre-nyugtázása,
  Fable overage consent stamp — ez mind Claude Code viselkedésre épül és
  **nem szabad módosítani** a meglévő Claude-ügynökök stabilitásának
  kockáztatása nélkül.
- Az inter-agent üzenetküldés (`sendPromptToSession`) tmux `send-keys`-re
  épül, DE a "kész-e a pane az üzenet fogadására" logika
  (`waitForPaneIdle`, `paneLooksIdle`, `detectsPastePlaceholder`,
  `shouldClearTruncatedPreamble`) **a Claude Code TUI konkrét
  megjelenésére van hangolva** (pl. a `[Pasted text #N]` placeholder
  formátum, a Claude-specifikus üres/foglalt állapot mintázat). Ezt
  **nem biztonságos újrahasznosítani változtatás nélkül** a Copilot CLI
  TUI-jára — pl. a dokumentált biztonsági megjegyzés szerint "Ctrl-C egy
  ÜRES Claude Code dobozon kilépteti a TUI-t", ami Copilot CLI-n más
  hatású lehet, és véletlenül kiléptetheti a Copilot-session-t.

## Architektúra

1. **Séma:** `agent-config.json` új, opcionális `engine` mező
   (`"claude"` alapérték a visszafele-kompatibilitásért | `"copilot"`). NEM
   `provider` a neve — az a kódban már foglalt a csatorna-típusra
   (telegram/slack/stb., ld. `resolveAgentProvider`/`agentProvider` az
   `agent-process.ts`-ben), és ütközne vele.
2. **Indítás:** `startAgentProcess` elején ág: ha `engine === 'copilot'`,
   hívja az új `startCopilotAgentProcess(name, opts)` függvényt — ez
   **különálló, egyszerű logika**, nem ágazik bele a meglévő Claude-útba.
   Parancs nagyjából: `copilot --allow-all-tools [--continue]
   --config-dir <izolált-mappa>` egy `agent-<name>` nevű tmux
   session-ben (ugyanaz az elnevezési konvenció, mint Claude-ügynököknél).
3. **Leállítás/státusz:** a meglévő, tmux-session-alapú
   `stopAgentProcess`/státusz-lekérdezés feltehetően változtatás nélkül
   működik (nem Claude-specifikus, session-létezést és tmux
   kill-session-t néz) — **implementáció közben ellenőrizendő**, nem
   feltételezett.
4. **Üzenetküldés:** **új, egyszerűsített** küldő-útvonal
   Copilot-ügynököknek — nincs idle-detektálás, nincs
   placeholder-discard, csak `tmux send-keys -l <szöveg>` + `Enter`, fix,
   konzervatív késleltetéssel. Kevésbé robusztus, mint a Claude-oldali
   verzió, de nem kockáztatja a jól bevált Claude-mechanizmus
   megbontását. Finomítható, ha éles használatban gondot okoz.
5. **Dashboard UI:** a "Csapat" oldal "Ügynök felvétele" űrlapján egy
   "Provider" választó (Claude / GitHub Copilot); az ügynök-kártyán
   megjelenik, melyik motort futtatja.
6. **Autentikáció:** a felhasználó saját maga jelentkezik be
   (`copilot login` vagy a meglévő WSL-session hitelesítése), Marveen nem
   kezeli automatikusan (a Claude fleet-OAuth-tokenes automatikájának
   Copilot-megfelelője NEM készül el ebben a körben — kézi bejelentkezés
   elég egy ügynökhöz).

## Kockázatok / nyitott kérdések

- **Üzenetkézbesítés megbízhatósága:** az egyszerűsített küldő-útvonal
  első implementációja lehet törékeny (pl. ha a Copilot CLI promptja
  többsoros beillesztésnél máshogy viselkedik). Élesben tesztelendő.
- **Session-resume szemantika:** a Copilot `--continue`/`--resume=<id>`
  viselkedése (mit tekint "legutóbbi session"-nek friss tmux-session
  után) nincs még tesztelve Marveen-integrációban.
- **`--config-dir` első indítás:** ismeretlen, hogy a Copilot CLI hogyan
  viselkedik egy vadonatúj, üres `--config-dir`-ral (pl. kér-e egy
  onboarding/trust dialógust, ami leblokkolná a headless indítást,
  hasonlóan a Claude "trust this folder" jelenséghez, amit a meglévő kód
  előre kezel Claude-hoz).

## Tesztelési terv

1. `copilot login` állapot ellenőrzése a felhasználóval közösen.
2. Kézi (nem Marveen-be épített) próba: `copilot --allow-all-tools
   --config-dir <teszt-mappa>` egy tmux session-ben, felügyelettel.
3. Marveen-be építve: egy teszt-ügynök felvétele `provider: copilot`-tal,
   indítás/leállítás dashboardról.
4. Inter-agent üzenet küldése a fő ügynöktől a Copilot-ügynöknek és
   vissza, ellenőrizve hogy a szöveg épen megérkezik-e.
5. Kanban-kártya hozzárendelése a Copilot-ügynökhöz, feladat elvégzésének
   megfigyelése.
