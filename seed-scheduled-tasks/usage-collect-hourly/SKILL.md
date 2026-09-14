---
name: usage-collect-hourly
description: Óránkénti kvóta-mérés (command típus, nincs LLM) -- a Claude Max 5 órás / heti / Fable-heti ablak used_percent + resets_at a scripts/usage-collect.py-ból a store/usage-latest.json-ba és a usage-history.jsonl-be
---

# usage-collect-hourly

Command-típusú feladat: a scheduler percenként ellenőrzi a cront, `:17`-kor lefuttatja a
`scripts/usage-collect.py`-t (bash -lc, 60 mp időkorlát, 3 egymás utáni hiba után riasztás).
Nincs LLM, nincs tmux, nem nyúl semmihez: a Max-előfizetés kvóta-ablakait olvassa
(five_hour, seven_day, seven_day_opus: used_percent + resets_at) és a store-ba írja.

Miért: a per-ügynök keret (kanban 5715dad4, Péter 2026-09-14) a kvóta %-át és a
`token_usage` tábla ügynökönkénti tokenjeit kalibrációval köti össze; ehhez legalább egy hét
óránkénti előzmény kell. 2026-09-14 előtt a script létezett, de ezen a gépen soha nem futott
ütemezetten (store/usage-latest.json nem létezett).

Kimenet: `store/usage-latest.json` (mindig a legfrissebb), `store/usage-history.jsonl`
(append-only, egy sor futásonként). Titkot soha nem ír ki. A reggeli napindító ebből egy sort
mutat Péternek.
