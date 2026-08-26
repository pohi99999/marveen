# Antigravity CLI (`agy`) mint valódi flotta-tag — design

**Előzmény:** ugyanaz a minta, mint a `docs/superpowers/specs/2026-08-26-copilot-fleet-agent-design.md`
(GitHub Copilot CLI engine), immár egy harmadik motorral kiegészítve. Az a
funkció már élesben fut és validálva van (`engine: 'claude' | 'copilot'`).
Ez a doksi csak a **különbségeket** és az `antigravity` engine hozzáadásához
szükséges konkrét munkát írja le — nem ismétli meg a Copilot-spec általános
indoklásait (azok változatlanul érvényesek: külön indító-útvonal, ne piszkáljuk
a Claude-specifikus workaroundokat, stb.).

## Cél

A felhasználónak Antigravity/Gemini előfizetése van, gyakran használja az
`agy` CLI-t (globálisan telepítve, WSL-ben elérhető a PATH-on). Szeretné, hogy
egy Marveen flotta-ügynök az `agy`-t futtassa motorként, hogy hitel-kimerülés
esetén (Claude vagy Copilot) át tudjon váltani rá.

## Kulcsfontosságú felfedezés: nincs szükség config-dir izolációra

A Copilot CLI-nél minden ügynöknek saját `--config-dir`-t adtunk, mert az
hordozza a hitelesítést is (közös OS-szintű tárolás nem volt igazolható). Az
`agy`-nál ez **más**:

- `~/.gemini/config/projects/<uuid>.json` egy `{"name": "<abszolút cwd>"}`
  rekordot tárol — a CLI **a induítási cwd alapján automatikusan létrehoz/
  újrahasznál egy projektet**, ugyanúgy, ahogy a Claude Code is cwd szerint
  kódolja a saját projekt-mappáját `~/.claude/projects/`-ban.
- Élő próba: `HOME` teljes felülírásával (`HOME=/tmp/agy-iso-test agy --print
  ...`) a CLI **nem talált hitelesítést** és interaktív OAuth-ot indított —
  tehát a hitelesítés a normál `$HOME/.gemini`-hez van kötve, NEM
  másolható/izolálható könnyen agent-onként anélkül, hogy újra be kellene
  jelentkezni minden egyes ügynöknél.
- Következtetés: **ne** izoláljunk teljes `HOME`-ot vagy config-dir-t.
  Induljon minden `antigravity`-motorú ügynök a saját `agentDir(name)`
  cwd-jéből (pont úgy, ahogy a Claude-motorú ügynökök is teszik ma) — ez
  automatikusan, ingyen ad neki különálló projektet/beszélgetés-előzményt,
  megosztott (egyszeri) bejelentkezéssel.

Ez EGYSZERŰBBÉ teszi ezt a motort, mint a Copilot-ot: nincs
`copilotConfigDir`-hez hasonló könyvtár-kezelés, nincs `mkdirSync` az indítás
előtt.

## CLI-felület (`agy --help` alapján, ellenőrizve)

Releváns kapcsolók:
- `--dangerously-skip-permissions` — automatikus jóváhagyás (mint Copilotnál
  `--allow-all-tools`, Claude-nál `--dangerously-skip-permissions`).
- `--continue` / `-c` — legutóbbi beszélgetés folytatása (cwd/projekt-
  szkópolt, ld. fent).
- `--model <id>` — pl. `gemini-3.7-flash-medium` (a felhasználó ezt
  preferálja alapértékként; `agy models` sorolja fel az érvényes ID-kat).
- `--effort <low|medium|high>` — csak akkor értelmes, ha a modell támogatja
  (a reasoning-modelleknél; ha a modell nem támogatja, a CLI figyelmen kívül
  hagyja vagy hibázik — build parancsnál csak akkor adjuk hozzá, ha explicit
  konfigurálva van, ugyanúgy mint a Copilot `--model`-nél).
- `--print` / `-p` — nem interaktív mód (NEM használjuk a flotta-indításnál,
  csak az interaktív, tmux-session-es módot akarjuk, mint Claude/Copilot
  esetén).

Nincs `--config-dir` vagy ezzel egyenértékű kapcsoló.

## Architektúra

1. **Séma:** `agent-config.ts` `readAgentEngine`/`writeAgentEngine` típusa
   bővül: `'claude' | 'copilot' | 'antigravity'`. Alapérték változatlanul
   `'claude'` minden hiányzó/ismeretlen értékre (visszafele-kompatibilitás).
2. **Indítás:** `startAgentProcess` (agent-process.ts) elején lévő
   `if (readAgentEngine(name) === 'copilot') { return startCopilotAgentProcess(...) }`
   ág mellé egy második ág kerül: `if (readAgentEngine(name) === 'antigravity')
   { return startAntigravityAgentProcess(...) }`. Új fájl:
   `src/web/antigravity-agent-process.ts`, a `copilot-agent-process.ts`
   mintájára, DE `configDir` nélkül:
   ```
   agy --dangerously-skip-permissions [--continue] [--model <id>] [--effort <lvl>]
   ```
   indítva `tmux new-session -d -s <session> -c <agentDir> <cmd>`-vel — a `-c`
   (cwd) adja a projekt-szkópolást, config-dir mkdir nélkül.
   `resume` eldöntése: mivel nincs saját `session-state` jelölőfájl-mappánk
   (az a Copilot config-dir-jában élt), a resume jelzőt egyszerű
   `existsSync(join(agentDir(name), '.antigravity-started'))` szentinellel
   oldjuk meg — az induláskor írjuk, és csak akkor adjuk hozzá a
   `--continue`-t, ha már létezik (első indításkor nincs mit folytatni).
3. **Leállítás/státusz:** változatlan, tmux-session-alapú, motor-független
   (`isAgentRunning`, `stopAgentProcess` már ma is csak a session nevét nézi).
4. **Üzenetküldés (message-router.ts):** a jelenlegi `isCopilotEngine`
   logikát **általánosítani kell**, mert ma szó szerint `=== 'copilot'`-ra
   van hardkódolva két helyen (readiness-gate skip + delivery-branch
   választás). A végső Copilot-review már felvetette ezt jövőbeli
   follow-upként ("a broader isClaudeEngine() guard") — ITT AZ IDEJE
   megcsinálni, mert egy harmadik `=== 'copilot'` melletti párhuzamos
   `=== 'antigravity'` ág lenne a legrosszabb duplikáció.
   Refaktor: `const engine = readAgentEngine(msg.to_agent)` egyszer, majd
   `const usesClaudeTuiDelivery = engine === 'claude'` a readiness-gate-hez,
   és a delivery-branchnél egy kis switch/if-lánc, ami `engine === 'copilot'`
   esetén `sendPromptToCopilotSession`-t, `engine === 'antigravity'` esetén
   egy új `sendPromptToAntigravitySession`-t hív. A COPILOT_UNTRUSTED_WARNING-
   hoz hasonló figyelmeztető szöveg és a `formatCopilotInboundMessage`-hez
   hasonló envelope-formázó az Antigravity oldalon is kell (saját,
   `formatAntigravityInboundMessage` néven — ugyanaz a tartalom, csak külön
   named export a jövőbeli motor-specifikus eltérések miatt).
5. **Üzenetküldés implementáció** (`antigravity-agent-process.ts`):
   `sendPromptToAntigravitySession` — SAME shape mint
   `sendPromptToCopilotSession` (newline-flattening + `withSessionSendLock`
   + `send-keys -l` majd `Enter`), mert az `agy` TUI-ja szintén ink-alapú
   (ugyanaz a `\r?\n` submit-probléma áll fenn).
6. **Dashboard UI:** az engine `<select>`-hez (web/index.html /
   web/app.js) egy harmadik opció: `Antigravity (Gemini)` érték
   `antigravity`. Ugyanott, ahol a Copilot opciót bekötöttük legutóbb.
7. **MCP-kötés és Telegram-csatorna:** NEM kötjük be (ugyanaz a döntés, mint
   Copilotnál) — külön munka lenne, más config-formátum (`agy mcp add`).

## Kockázatok / eltérések a Copilot-mintától

- **Resume-szemantika ellenőrizetlen élesben.** A cwd-alapú projekt-szkópolást
  csak `agy models`/`agy --print` szintű próbákkal igazoltuk, nem egy teljes
  `--continue` roundtrippel ugyanabból a mappából. Az élő WSL-tesztnek EZT
  kifejezetten ellenőriznie kell: indítsd el, zárd le, indítsd újra
  `--continue`-val ugyanabból a `agentDir`-ből, és nézd meg, hogy a korábbi
  beszélgetés tényleg folytatódik-e (nem egy üres/más session).
- **`--effort` kompatibilitás modellenként ismeretlen** — ha a kiválasztott
  modell nem támogatja, lehet hogy a CLI hibázik induláskor a `--effort` flag
  miatt. A command builder csak akkor adja hozzá, ha explicit meg van adva
  (ugyanaz a minta, mint a Copilot `--model`-nél); teszt kell rá, hogy hiányzó
  `effort` esetén a flag teljesen elmarad.
- **Az `isClaudeEngine` refaktor kockázatos, megosztott kódot érint** — ugyanaz
  a fájl (message-router.ts), ahol a Copilot végső review egy KRITIKUS hibát
  talált (readiness-gate elrejtette a delivery-branchet). Ez a feladat kapja a
  legerősebb modellt és egy külön, alapos review-kört, pont úgy, mint legutóbb.

## Végrehajtási terv

Lásd: `docs/superpowers/plans/2026-08-26-antigravity-fleet-agent.md`
