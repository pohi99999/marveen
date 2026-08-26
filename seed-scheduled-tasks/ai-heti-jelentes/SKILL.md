---
name: ai-heti-jelentes
description: Heti AI-felderites osszefoglalo a tulajdonosnak + kanban-javaslatok, jovahagyas utan vegrehajtas. Az "ai-heti-felderites" (Zeph) parja, kb. 2 orat kesobb fusson.
---

# Heti AI-felderítés jelentés

> Cél: a tulajdonos kapjon egy tömör, priorizált összefoglalót a heti
> AI-felderítésről, és a fő ágens javasoljon bevezetést — de SEMMIT nem
> telepít jóváhagyás nélkül.

## Eljárás

1. Olvasd be a kutató ágens (pl. Zeph) legfrissebb heti AI-felderítő
   jelentését (shared memória + az Obsidian "02_Areas/AI eszköz-felderítés/"
   legújabb jegyzete).

2. Szintetizáld egy tömör Telegram-üzenetbe {{OWNER_NAME}}-nek: top 3-5
   találat, miért releváns, a TE ajánlásod mindegyikhez (bevezetni / figyelni
   / kihagyni) röviden indokolva.

3. Minden "bevezetni" javasolt tételhez hozz létre egy kanban-kártyát
   (`status: waiting`, `assignee: {{MAIN_AGENT_ID}}`, cimke: `ai-felderites`)
   a javaslat szövegével.

4. Kérdezd meg {{OWNER_NAME}}-t egyértelműen a Telegram-üzenet végén,
   jóváhagyja-e ezeket — akár csak napokkal később is válaszolhat, ez NEM
   szinkron approval-API-s jóváhagyás-kérés (annak órás timeoutja erre a
   ritmusra nem illik).

5. Ha a kutató ágensnek nincs friss jelentése (pl. a felderítő kör még nem
   futott le vagy hibázott), jelezd ezt röviden, ne találj ki tartalmat.

## Jóváhagyás utáni végrehajtás

Amikor {{OWNER_NAME}} egy KÉSŐBBI üzenetében jóváhagy egy tételt:

- **SOHA ne telepíts/kapcsolj be/módosíts semmit anélkül, hogy ez az
  explicit jóváhagyás megtörtént** — ez nem az autonómia-szintes
  gyors-jóváhagyás, hanem név szerinti megerősítés kell minden egyes
  tételhez.
- Jóváhagyás után végezd el a bevezetést, vagy delegáld a megfelelő
  ügynöknek (új MCP-szerver tesztelése/bekötése tipikusan a kísérletező
  ügynöknek, kód-jellegű változás a fejlesztő ügynöknek).
- Külső telepítő/szkript esetén kövesd a `kulso-telepito-ellenorzes` elveit
  is (eszkalálás → ellenőrzés → csak utána telepítés), ha van ilyen skill
  telepítve.
- Mozgasd a kanban-kártyát `done`-ba, és jelezz vissza {{OWNER_NAME}}-nek,
  hogy megtörtént.

## Buktatók

- Ne hozz létre kártyát "figyelni"/"kihagyni" ajánlású tételekhez — csak a
  "bevezetni" javasoltakhoz.
- Ne ismételd meg ugyanazt a javaslatot minden héten, ha már egyszer
  elutasításra került — nézd meg a korábbi kártyákat/jegyzeteket előbb.

## Ellenőrzés

- A Telegram-üzenet kiment.
- A kanban-kártyák létrejöttek a megfelelő tételekhez.
