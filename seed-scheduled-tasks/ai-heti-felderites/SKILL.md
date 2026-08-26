---
name: ai-heti-felderites
description: Heti AI/MCP/skill-felderites hetfonkent - jelentes Brunellanak, telepites nelkul. Az "ai-heti-jelentes" parja, azzal egyutt kapcsold be.
---

# Heti AI-felderítő kör

> Cél: a csapat lépést tartson a legújabb, TÉNYLEGESEN releváns
> AI-fejleményekkel, anélkül hogy bárki mindent magának kellene követnie.

## Eljárás

1. `WebSearch`-csel (beépített Claude Code eszköz, NEM MCP) nézd át az elmúlt
   kb. 7 nap releváns találatait: Anthropic/Claude Code changelog és blog,
   új vagy frissült MCP-szerverek, releváns GitHub trending repók,
   agent-framework/eszköz hírek. Szűrj a MI stackünkre — ne általános
   AI-hírfolyamot gyűjts, cseréld le a saját projekt-stackedre a telepítéskor.

2. Minden találatnál írd le: mi ez, miért lehet KONKRÉTAN hasznos nekünk
   (kösd egy valódi projekthez vagy ismert fájdalompontunkhoz, ha lehet),
   mennyi bevezetési/kockázati költséggel jár, és a saját ajánlásod
   (bevezetni / figyelni / kihagyni).

3. Mentsd el a jelentést Obsidianba (`obsidian-vault` MCP) a
   `02_Areas/AI eszköz-felderítés/` mappába, dátumozott jegyzetként.

4. Mentsd el a jelentés lényegét `shared`-tier memóriaként is (saját
   `agent_id`-ddel), hogy a fő ágens közvetlenül is lássa.

5. Küldj inter-agent üzenetet a fő ágensnek (`to: {{MAIN_AGENT_ID}}`) a
   lényeggel (top 3-5 találat egy mondatos összefoglalóval) és a jegyzet
   elérési útjával.

## Buktatók

- **SOHA ne telepíts/kapcsolj be/módosíts semmit ezen a körön magadtól** —
  ez csak felderítés és jelentés. A tényleges bevezetés a fő ágens dolga, a
  tulajdonos jóváhagyása után (lásd az `ai-heti-jelentes` társ-feladatot).
- Ne gyűjts általános AI-hírfolyamot — csak azt, ami a saját stackhez és
  projektekhez ténylegesen kapcsolódik.

## Ellenőrzés

- Az Obsidian-jegyzet létrejött a megfelelő helyen.
- Az inter-agent üzenet sikeresen kiment (200-as válasz).
