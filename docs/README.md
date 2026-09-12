# Marveen — Funkció-dokumentáció

Marveen egy önfejlesztő, proaktív AI-asszisztens rendszer Claude Code alapokon. Nem chatbot: ügynök-flotta, amely magától észreveszi a tennivalót, emlékszik, tanul, és a háttérben dolgozik.

Minden lap két szemszögből mutatja be a funkciót:
- **🎯 Mit tud / miért érdekes** — közérthető bemutatás, kuriózumok, használati példák
- **🛠 Hogyan működik** — technikai felépítés, hogyan bővíthető

## Funkciók

| Funkció | Leírás |
|---------|--------|
| [Heartbeat + fokozatos autonómia](heartbeat-autonomy.md) | Önjáró ütemezett ellenőrzések + kategóriánként állítható bizalmi-létra (jelez → javasol → autonóm) |
| [Memória-rendszer](memory-system.md) | 3-tier (hot/warm/cold) FTS5 + napi salience decay + napi napló |
| [Kanban + auto-breakdown](kanban.md) | Feladatkezelés LLM-es részfeladat-bontással |
| [Ügynök-flotta + inter-agent kommunikáció](agent-fleet.md) | Több specializált ügynök közös üzenetsoron keresztül |
| [Föderáció](federation.md) | Több Marveen-példány összekötése: rendszer-minősített címzés (`teodor/backend-dev`) + HTTPS-híd, dashboard-menü, per-társ tokenek, automatikus ügynök-felkészítés, **képesség-alapú auto-routing** (LLM-katalógus) + fő-ügynök auto-drain, beépített rollback — opt-in, fail-closed |
| [Skill-factory (öntanulás)](skill-factory.md) | Visszatérő munkafolyamatokból újrahasznosítható skill-ek |
| [Channels (Telegram / Slack)](channels.md) | Natív üzenetküldő-integráció proaktív értesítésekkel |
| [Hangüzenetek (voice)](voice.md) | Per-agent STT+TTS: helyben futó hang oda-vissza Telegramon, ügynökönként állítható móddal |
| [Printing-press CLI-k](printing-press-cli.md) | API nélküli oldalakhoz is agent-natív CLI generálás |
| [Skool CLI](skool-cli.md) | Közösségi platform kezelése parancssorból (API nélkül) |
| [connectors.hu](connectors-hu.md) | Üzleti API-átjáró (NAV, Billingo, Wise, fal.ai) MCP-n |
| [Vault & titkosítás](vault.md) | Titkosított titok-tár (AES-256-GCM) OS-kulcstárral |
| [Belépés-visszaút & vészreset](dashboard-auth-recovery.md) | Elfelejtett jelszó, kizárás, `security:reset` pánikgomb -- HTTP-független break-glass CLI |
| [Dream-engine](dream-engine.md) | Éjszakai tudás-konszolidáció + reggeli prioritás-javaslatok |
| [Proaktív hírszerző (intel registry)](intel-registry.md) | Óránkénti gyűjtő + napi brief közös SQLite tény-registry-vel, dedup + tény-életciklus |
| [Háttér-feladatok](background-tasks.md) | Leválasztott, hosszú feladatok futtatása + értesítés |

*A dokumentáció él; javításokat/bővítéseket szívesen fogadunk.*

<!-- DOC_STATS_START -->
## Auto-generált projekt-statisztika

_Ezt a blokkot a `node scripts/docs-drift.mjs --write` frissíti; a `--check` (doctor.sh, CI) elbukik, ha elavult. Kézzel ne szerkeszd. Csak követett fájlokból számol (az `agents/` és a `.mcp.json` host-lokális, ezért nincs itt)._

- Route-modulok (`src/web/routes/*.ts`): **47**, egyedi `/api/...` útvonal-literál bennük: **134**
- Claude Code hookok (`.claude/settings.json`): **5** esemény, **15** bejegyzés, **10** szkript a `scripts/hooks/` alatt
- Seed ütemezett feladatok (`scheduled-tasks/`): **4** -- dream-engine, ledger-live-drain, memoria-heartbeat, reggeli-napindito
- Git-hook telepítők (`scripts/install-*-hook.sh`): **7** -- channel-image, git-guard, hook-proof, prod-tree-guard, secret-gate, telegram-image, telegram-progress
- Dokumentációs lapok a `docs/` alatt: **41**, ebből a fenti táblázat linkel **16**

### Lapok, amiket a fenti táblázat még nem sorol be

- [MIGRATION](MIGRATION.md)
- [archivalt-kartyak](archivalt-kartyak.md)
- [channel-reply-guard](channel-reply-guard.md)
- [config-reference](config-reference.md)
- [conversation-continuity](conversation-continuity.md)
- [disk-modal-guards](disk-modal-guards.md)
- [external-skill-catalog](external-skill-catalog.md)
- [flotta-migracio](flotta-migracio.md)
- [google-docs](google-docs.md)
- [ideabox](ideabox.md)
- [inter-agent-send-reliability](inter-agent-send-reliability.md)
- [kutatas](kutatas.md)
- [mobil-dashboard](mobil-dashboard.md)
- [munkamodszer](munkamodszer.md)
- [naplo-audit](naplo-audit.md)
- [onboarding-uj-asszisztens](onboarding-uj-asszisztens.md)
- [outgoing-copy-gate](outgoing-copy-gate.md)
- [scheduled-tasks](scheduled-tasks.md)
- [security-hardening](security-hardening.md)
- [telegram-live-progress](telegram-live-progress.md)
- [telegram-progress-indicator](telegram-progress-indicator.md)
- [telegram-reply-enforcement-2026-08-02](telegram-reply-enforcement-2026-08-02.md)
- [tippek-trukkok](tippek-trukkok.md)
- [token-usage](token-usage.md)
- [upstream-ledger](upstream-ledger.md)

<!-- DOC_STATS_END -->
