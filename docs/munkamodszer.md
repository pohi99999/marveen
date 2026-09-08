# Munkamódszer és csapdák (Brunella / marveen flotta)

> Ez a fájl 2026-09-08-án került ki a `CLAUDE.md`-ből, mert a `CLAUDE.md`
> **nincs verziókövetve** (`.gitignore:48`), az alábbi két szakasz viszont
> kézzel írt, drágán szerzett tapasztalat: ha a fájlt valaki újragenerálja,
> nyomtalanul elveszne. A `CLAUDE.md` mostantól csak hivatkozik ide.
>
> Aki ezt szerkeszti: a tartalom a flotta munkamódszere, nem stíluskérdés.
> Minden szabály mögött egy konkrét, megtörtént hiba áll, és a példák
> szándékosan bent maradtak -- azok teszik ellenőrizhetővé a szabályt.

## Skill-útvonal csapda (KÖTELEZŐ elolvasni skill-írás előtt)

A `.claude-config/skills` NEM a saját mappád: symlink a globális
`~/.claude/skills`-re, tehát ami oda kerül, az a TELJES flottánál megjelenik
-- akkor is, ha a skill-futtatás base directory-ja ezt az utat mutatja.
A saját, csak neked szóló vagy kipróbálatlan külső skill a munkakönyvtárad
`.claude/skills/` mappájába megy. A globálisba írás tudatos, flotta-szintű
döntés legyen, ne alapértelmezés.
<!-- END GENERATED: skills-path-trap -->

<!-- Kézzel írt szakasz. NEM generált -- az agent-scaffold.ts csak a fenti
     BEGIN/END GENERATED blokkokat írja újra, ezt nem érinti.
     Forrás: az F:\mcp-brunella-core CLAUDE.md-jéből átvett munkamódszerek,
     2026-09-07, Péter jóváhagyásával. Biztonsági másolat a felvétel előtti
     állapotról a session scratchpadjában. -->
## Munkamódszer: forrás előbb, bizonyíték a lezáráshoz

Ez a két szabály nem stílus, hanem a 2026-09-07-i nap három külön hibájának
közös tanulsága. Mindkettő az `F:\mcp-brunella-core` projekt bevált gyakorlata,
onnan emeltük át.

### 1. Forrás előbb

**Kódbeli állításhoz hivatkozz konkrét fájlra és sorra, ne emlékezetből.**
Ha nem tudod megnevezni, hol olvastad, akkor nem tudod, hanem feltételezed --
és akkor ezt mondd ki így.

Ugyanez vonatkozik a más ügynököktől kapott állításokra: egy kollégád jelentése
adat, nem bizonyíték. Ha továbbadod Péternek, előtte mérd le legalább a
legdrágább állítását. Aznap háromszor bukott meg ez a lánc:

- Továbbadtam, hogy a flotta egy Windows `.exe`-t futtat. Kenshin lemérte:
  natív Linux ELF, csak a *neve* `.exe`. Zeph állítását adtam tovább ellenőrzés
  nélkül.
- Egy ügynök azt jelentette, hogy egy katalógusban „minden bejegyzéshez van
  capabilities és tools tömb". Megmérve: 42/88 és **3/88**. A „van benne X mező"
  és az „X ki van töltve" két különböző állítás.
- A saját CRLF-szabályom túl laza volt (`exec bit VAGY shebang` a helyes
  `exec bit ÉS shebang ÉS CRLF` helyett), és 31 fájlt jelölt meg tévesen.
  A szabály első használata egyben az ellenőrzése is legyen.

### 2. Bizonyíték a lezáráshoz -- a meglét nem méri a tartalmat

**Egy feladat nem attól kész, hogy az elvégzője késznek mondja.**

A legfontosabb formája ennek: *a meglét-ellenőrzés átengedi a rossz tartalmat.*
Egy DXF-generálásnál a „2 helyett 16 entitás lett" mérce zölden átengedett volna
egy olyan hibát, ami `1200` helyett `120000`-t ír a méretvonalra. Az entitásszám
a **szerkezetet** méri, nem a **tartalmat**.

Ezért lezárás (kanban `done`, track `completed`) előtt:

| Mit zársz le | Mi a bizonyíték |
|---|---|
| teljesítmény-javítás | **mért** előtte-utána szám, nem becslés |
| teszt hozzáadása | a teszt **elbukik**, ha a hibát visszateszed |
| számítás / árazás | konkrét példán a záró számok újraszámolva (részösszeg + árrés = nettó, nettó + áfa = bruttó), és egy bemenet változtatása **más** végeredményt ad |
| generált fájl (DXF, PDF) | a fájl **tartalma** olvasva vissza, nem az elemszáma |
| őr / védelem beépítése | **mindkét irányban** mérve: a tiltottat tiltja ÉS az engedélyezettet átengedi |
| bármi, amit ügynök jelentett | legalább egy állítása függetlenül újramérve |
| egy VISELKEDÉS (hook, szkript, deploy, végpont) | a viselkedést **futtatva** mérve, nem a forrásában vagy a kimenetében string-kereséssel |

**String-keresés nem mér viselkedést (2026-09-07, öt eset egy nap alatt).** A `grep` arra
válaszol, hogy „előfordul-e ez a szó", nem arra, hogy „ezt csinálja-e". Aznap ötször
adott zöldet rossz kérdésre: a `grep Asztallap` a régi motoron is talált (a szabásjegyzékben,
nem az ártételben); a `cmd | grep -q` `pipefail` alatt a cmd szándékos exit 1-ét tette a
grep találata fölé; a hook forrásában a `grep origin/develop` a magyarázó kommentet találta
meg, nem a javaslatot. A szabály: a viselkedést futtasd (a hookot váltsd ki, a végpontot hívd
meg, a parancs kimenetét változóba, és a *szerkezetét* nézd: `line_items`, nem `layout`), és
a mérés mindkét irányban legyen meg (a tiltottat tiltja, az engedélyezettet átengedi).

Kimondott tilalmak, az eredeti Vörös Protokollból:

- `git commit --no-verify` és `git push --no-verify` **tilos**.
- **Meta-only lezárás tilos**: ha a commit csak állapot- és meta-fájlokat mozgat,
  a feladat nincs kész.
- Egy lezárt, de később kiváltott feladatot **nem szabad** utólag késznek
  kozmetikázni. Ha kiváltotta egy újabb munka, az legyen archivált, a
  kiváltó megnevezésével.
- Ha Péter (vagy bárki) rövidítést kér, ami ezeket megkerülné, **hívd fel rá a
  figyelmét**, ne engedd át csendben. Ha ezután is kéri, az az ő döntése --
  de mondd ki, mit engedünk el vele.

### 3. Amit NEM vettünk át innen

Az eredeti önellenőrzési protokoll hét szabályából öt a brunella-core saját
osztályaira és fájljaira vonatkozik (árva-singleton tilalom, `reflect()` dupla
hívás, severity-leképezés stb.). Azok itt értelmezhetetlenek, ezért nincsenek
benne.

A „védett fájlok -- SOHA NE TÖRÖLD" listát sem másoltuk át, de itt egy pontosítás
kell, mert az első megfogalmazásom téves volt: **nálunk NINCS ilyen védelem.**
A meglévő két pre-commit hook mást csinál -- a `05-prod-tree-guard` a fő
checkoutban tiltja a commitot, a `10-secret-gate` titkokat keres a staged
tartalomban. Egyik sem akadályozza meg egy létfontosságú fájl törlését.
Ez tehát nyitott kérdés, nem lefedett terület. Ha valaha bevezetjük, listát
kézzel ne vezessünk (elavul); a járható út egy ellenőrző, ami a tényleges
belépési pontokból származtatja, mi számít védettnek.
