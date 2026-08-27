# Napi B2B outreach automatizálás — Agy ütemezett feladatként

**Dátum:** 2026-08-27
**Státusz:** Jóváhagyásra vár (spec review)
**Érintett rendszerek:** Marveen flotta (`agy-test` ügynök), `E:\OneDrive\Desktop\profil építés`
(Péter saját, `pohi99999/work.git`-be commitolt outreach-eszközkészlete), n8n, Gmail (IMAP).

## Cél

Péter jelenleg minden nap kézzel ír be egy promptot az Agy CLI-be (`E:\OneDrive\Desktop\profil
építés` mappában), amivel: (1) ellenőrizteti és javíttatja az n8n workflow-kat, (2) 10 új,
valós email című, gyenge/nincs weboldalú vállalkozást kerestet fel, (3) személyre szabott
piszkozatot írat mindegyiknek, (4) beteteti ezeket a Gmail piszkozatok közé. A cél, hogy ez a
teljes kör **naponta, ember nélkül** lefusson, és reggelre készen álljanak a piszkozatok —
Péter kizárólag a tényleges elküldést (8:00 / 13:00) végzi kézzel.

**Nem cél:** a tényleges email-küldés automatizálása. Az drafts-only marad — Péter szándékos
döntése, mert a küldés visszavonhatatlan és reputáció-kockázatos.

## Előzmény és amit a felmérés feltárt

- A mögöttes gépezet **már létezik és működik**: `skyvern.db` (SQLite, `b2b_leads` tábla,
  `status: Scraped → Draft Created` állapotgép), IMAP-alapú piszkozat-beszúrás
  (`create-personalized-drafts.js`), `crm-tracker.md` napló. Ez hónapok óta iterált,
  bevált mechanizmus — nem újraépítjük, hanem beütemezzük és megtisztítjuk.
- **Súlyos, már javított biztonsági hiba**: 52 fájl (a `create-personalized-drafts.js` és
  44 dátumozott `send-*-leads-*.cjs` egyszer-használatos másolat) nyílt szövegben tartalmazta
  a Gmail App Password-öt. Péter visszavonta/újragenerálta a jelszót, az aktívan használt 8
  script mostantól `.env`-ből (`GMAIL_USER`/`GMAIL_PASSWORD`) olvas, a 44 elavult másolat
  törölve (`git rm`, még nem commitolva — Péter kérésére a takarítást a projekt végén
  commitoljuk egyben).
- **Kritikus architektúra-korlát**: az `agy-test` ügynök `antigravity` motoron fut (`agy`
  CLI), aminek **nincs bekötve sem MCP, sem Telegram-csatorna** (tudatos tervezési döntés,
  ld. `docs/superpowers/specs/2026-08-26-antigravity-fleet-agent-design.md`). Ez azt jelenti:
  - Agy nem tud közvetlenül Telegram-üzenetet küldeni Péternek.
  - Agy nem ér el semmilyen Claude-Code-MCP-szervert (pl. `n8n` MCP a `agy-test/.mcp.json`-ban
    definiálva van, de az antigravity motor ezt a fájlt nem olvassa — ez Claude-motoros
    session-ök konfigja, nem `agy` CLI-é).
  - Amit Agy **tud**: shell-parancsokat futtatni (tehát `curl`-lal hívhatja az n8n REST API-t
    közvetlenül, `N8N_API_KEY`-jel a `.env`-ből), fájlokat írni/olvasni/futtatni bármelyik
    mountolt útvonalon (`/mnt/e/OneDrive/Desktop/profil építés`), és inter-agent üzenetet
    küldeni a flotta többi tagjának (`POST /api/messages`, motorfüggetlen mechanizmus).
  - **Következmény a hibakezelésre**: ha Agy elakad vagy hibát talál, amit nem tud önállóan
    javítani, **Brunellának küld inter-agent üzenetet**, Brunella pedig (aki rendelkezik
    Telegram-csatornával) továbbítja Péternek. Ez NEM közvetlen Agy → Telegram út.

## Architektúra

### 1. Ütemezés
Új Marveen scheduled task, `agy-test`-hez kötve:
`seed-scheduled-tasks/napi-b2b-outreach/task.json`, cron `0 6 * * *` (minden nap 06:00,
Péter idehazai idejében) — azért ilyen korán, hogy a piszkozatok készen álljanak a 8:00-as
kézi küldés előtt. Mintaként a meglévő `seed-scheduled-tasks/projekt-figyelo/` szolgál
(heartbeat-típusú, prompt-alapú feladat).

### 2. Munkamegosztás: Agy (ítélőképesség) vs. determinisztikus script (végrehajtás)
A kockázatos/mechanikus lépéseket (email-validáció, IMAP-írás, DB-frissítés) egy
**determinisztikus Node-scriptbe** különítjük, hogy Agy tévedése (pl. rosszul formázott
email) ne okozzon közvetlen Gmail-műveletet. Agy csak **kutat és szöveget ír**, a tényleges
piszkozat-beszúrást a script végzi.

```
Agy (napi ütemezett prompt)
  ├─ 1. n8n audit + javítás (curl + N8N_API_KEY)
  ├─ 2. skyvern.db lekérdezés: van-e ≥10 Scraped + email lead?
  │     ha nincs → kutatás (meglévő Skyvern-scraper vagy saját webes kutatás)
  ├─ 3. minden új jelölt e-mailre: scripts/validate-email.cjs <email>  (MX + SMTP-check)
  │     érvénytelen → eldob, tovább keres
  ├─ 4. dedup: skyvern.db meglévő rekordjaihoz képest (email már szerepel-e)
  ├─ 5. mély, egyedi piszkozat-szöveg megírása leadenként (Agy saját LLM-tudása)
  ├─ 6. leads.json (scratch fájl) kiírása: [{name, email, city, category, subject, body}, …]
  ├─ 7. node scripts/daily-outreach.cjs --input leads.json   (determinisztikus végrehajtás)
  │     → IMAP draft-append, skyvern.db UPDATE status='Draft Created', crm-tracker.md sor
  ├─ 8. GEMINI.md + Obsidian napló bejegyzés
  ├─ 9. git add + commit + push (work.git)
  └─ 10. hiba esetén bármely lépésnél → inter-agent üzenet Brunellának, Brunella jelez Péternek
```

### 3. `scripts/daily-outreach.cjs` (új, a 44 dátumozott másolat helyett)
Egyetlen újrafelhasználható script, ami a `create-personalized-drafts.js` bevált IMAP-logikáját
viszi tovább, de:
- `--input <json-fájl>` paraméterrel kapja a leadeket (Agy írja ki), nem hardcode-olt tömbből.
- `--dry-run` kapcsolóval a valódi IMAP-írás és git-push nélkül csak logolja, mit tenne — **az
  első 1-2 élő futtatáshoz javasolt**, hogy Péter ellenőrizhesse felügyelet mellett, mielőtt
  teljesen őrizetlenül fut.
- Hitelesítés kizárólag `.env`-ből.
- Minden nap ugyanaz a fájl fut, nincs új dátumozott másolat.

### 4. `scripts/validate-email.cjs` (új)
Kis segédfüggvény: DNS MX-lookup (`dns.resolveMx`) + SMTP `RCPT TO` handshake tényleges levél
küldése nélkül, hogy kiszűrje a nem létező/visszapattanó címeket, mielőtt piszkozat készülne
hozzájuk. Nincs hozzá fizetős külső API — Node beépített `dns` és `net` modulokkal
megvalósítható, illeszkedik Péter jelenlegi költséghatékonysági preferenciájához.

#### 4.1. Megvalósítási megjegyzés: MX-only validáció az outbound port 25 blokkolása miatt

**Megállapítás (Task 2, 2026-08-27):** Az outbound 25-ös port ebben a hálózati környezetben
blokkolva van. Emiatt az SMTP `RCPT TO` handshake (teljes validáció) nem hajtható végre. 
Az implementáció ezért **MX-only módban** működik: 
- Érvényes e-mail: `{ valid: true, reason: 'mx-only' }`
- Érvénytelen/nincs MX: `{ valid: false, reason: 'no-mx' }`
- Malformed: `{ valid: false, reason: 'malformed' }`

Az MX-only validáció **gyengébb jel**, mint a tervezett teljes SMTP-check:
- MX rekord létezése csak azt jelenti, hogy a domain tekintélyes szerverrel rendelkezik,
- **nem** erősíti meg, hogy a konkrét email-cím valóban fogad e-maileket.
- Hamis pozitívok lehetségesek (pl. "postmaster@valodi-domain.com" fogadhat, de
  "semmitevő@valodi-domain.com" elutasítódhat).

**Fogyasztók felé ajánlás:** A `mx-only` ok **nem jelenti a garantált érvényességet** —
valós üzenetküldés előtt manuális vagy egyéb (3p API) validáció javasolt, ha kritikus
a domain érvényes eletét.

## Adatfolyam

`skyvern.db (b2b_leads)` ←olvas/ír→ `daily-outreach.cjs` ←hívja→ `Agy` (kutatás + szövegírás)
→ `leads.json` (scratch, git-ignore-olt) → `daily-outreach.cjs --input` → Gmail IMAP (piszkozat)
+ `skyvern.db` UPDATE + `crm-tracker.md` append → `GEMINI.md` + Obsidian napló → git commit+push.

## Hibakezelés

- n8n API elérhetetlen / hiba nem javítható → Brunellának üzenet, folytatás a lead-kutatással
  (nem blokkol egymást a két fő ág).
- Nincs elég valid email 10-hez → Agy addig kutat, amíg megvan, vagy maximum ~30 perc után
  jelez Brunellának, hogy kevesebbel (vagy semmivel) zárta a napot.
- IMAP-hiba (pl. Google átmenetileg letiltja) → a script leállítja a hátralévő IMAP-írásokat,
  a már elkészült piszkozatokat megtartja, hibát logol, Agy jelez Brunellának.
- Git push ütközés → Agy NEM force-pusholhat; ha ütközik, jelez Brunellának kézi feloldásra
  (ugyanaz az elővigyázatosság, mint a [[2026-08-26-git-checkout-divergence-and-sync-procedure]]
  tanulságban).

## Tesztelés

1. Első 1-2 futtatás **`--dry-run`**-nal, kézzel indítva (nem ütemezve), Péter ellenőrzi a
   kimenetet (mit talált volna, milyen szöveget írt volna).
2. Ezután élesítjük `--dry-run` nélkül, de még kézzel indítva 1-2 napig.
3. Csak ezután kerül be az ütemezésbe (`0 6 * * *`), teljesen felügyelet nélkül.
4. `scripts/validate-email.cjs` önállóan tesztelhető ismert érvényes/érvénytelen címekkel.

## Nyitott kérdés a végrehajtás előtt

A meglévő Skyvern-scraper (`web-rescue-scraper.cjs`, jelenleg kikommentezve a
`daily-b2b-drafts.cjs`-ben) állapotát még nem ellenőriztem élőben — a végrehajtási tervben
első lépésként ezt kell tesztelni, mielőtt Agy rá támaszkodna a napi kutatáshoz.

### Task 1 eredménye (2026-08-27): scraper CAPTCHA-blokkba fut, nyitott kérdés marad

A `web-rescue-scraper.cjs` önálló tesztfuttatása (`node scripts/web-rescue-scraper.cjs
"könyvelő" "Kecskemét"`) **nem** Puppeteer-indítási hibát adott — a böngésző elindult, a
Chrome-binaris és a rendszerfüggőségek rendben vannak. A hiba a célwebsite oldalán jelentkezik:

- **Google Search**: a keresés reCAPTCHA-falba fut ("Our systems have detected unusual
  traffic from your computer network"), a `div.g` szelektor sosem jelenik meg.
- **DuckDuckGo HTML fallback** (a scraper második próbálkozása): szintén bot-elhárítási
  kihívásba fut ("Unfortunately, bots use DuckDuckGo too" — kép-CAPTCHA), a `div.result`
  szelektor sosem jelenik meg.
- Eredmény: 0 kinyert lead, 0 új sor a `b2b_leads` táblában (a legutolsó `status='Scraped'`
  sor változatlanul a 2026-08-07-i, 20 napja).
- A kimenő IP valódi, a felhasználó saját magyarországi (Magyar Telekom) hálózati címe —
  tehát nem egy gyanús adatközponti proxy váltja ki a blokkot, hanem feltehetően maga a
  hálózat/IP van megjelölve a Google/DDG felől a scraper korábbi, hónapok óta tartó
  ismételt automatizált forgalma miatt.
- Ez a hibamód pontosan az volt, amit ez a brief Step 1-je előre jelzett lehetőségként
  ("CAPTCHA-blokk"), de a Step 3 dokumentált javítása (hiányzó Chrome-függőségek telepítése)
  erre nem vonatkozik — nem indítási hiba, hanem éles bot-elhárítás.
- **Nem próbáltam** további, a brief által nem dokumentált megoldásokat (más keresőmotor,
  proxy/IP-rotáció, várakozás/backoff, user-agent csere, CAPTCHA-megoldó szolgáltatás) —
  ezek mind találgatás lettek volna a hatáskörön kívül, a controller döntésére vár.
- **Következmény a `daily-b2b-drafts.cjs`-re**: a Step 4 (scraper-hívás kikommentezésének
  megszüntetése) emiatt **nem történt meg** — a kód maga jónak tűnik (korábban, 2026-08-07-ig
  sikeresen írt be sorokat), de élesítés előtt tisztázni kell, hogy ez most egy átmeneti
  (pár napos) IP-elhárítás-e, vagy tartós, ami miatt más kutatási stratégia kell Agy számára.
