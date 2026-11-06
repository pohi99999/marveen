# Csak olvasó HTTP-mérés: `POST /api/http-probe`

Az Ellenőr és a többi ügynök ezzel méri egy saját vagy ügyfél-oldal ÉLŐ viselkedését: státusz, átirányítás, egy szövegrészlet bájtpontosan. A kérést a dashboard küldi el, egyszer, determinisztikusan.

**Miért kell:**
- A quarantine-reader tartalma modell által újraírt leírás (WEBFETCHFAB819), ezért egy státuszkód vagy szöveg-egyezés onnan gyenge bizonyíték.
- A Bash-curl-t az egress-kapu vágja.
- Az `egress-vendor-hosts.json` kivétel minden curl-alakot átengedne a felsorolt hosztra, a POST-ot is.

## Használat

```bash
curl -s -X POST http://localhost:3420/api/http-probe \
  -H "Authorization: Bearer $(cat /Users/pohi/marveen/store/.dashboard-token)" \
  -H 'Content-Type: application/json' -H 'X-Agent-Id: ellenor' \
  --data-binary @probe.json
```

`probe.json`:

```json
{ "url": "https://<ugyfel-domain>/kinalat/valami", "method": "GET", "follow": false, "contains": ["Eladó", "404"] }
```

A válasz `hops` listája kérésenként (hoponként) ezeket tartalmazza:
- `status`, `location`, `contentType`, `contentLength`;
- `bodyBytes`, `truncated`, `bodySha256`, `title`;
- `contains`: tűnként `found`, `count`, `firstOffset`, és a találat körüli 60-60 bájt.

A `final` az utolsó hop. Ha egy átirányítás a listán kívüli hosztra mutat, ott megáll (`stoppedAt`), és azt a hosztot nem kéri le.

## Korlátok

- **Kérés:** csak GET vagy HEAD. Kérés-törzs, saját fejléc és süti nincs. A User-Agent fix: `marveen-http-probe/1 (read-only QA)`.
- **Engedélyezett hosztok:** csak a `store/http-probe-hosts.json`-ban felsoroltak. Formátum: `{ "hosts": ["www.pelda.hu"], "domains": ["pelda.com"] }`.
  - A `hosts` pontos egyezés.
  - A `domains` címkehatárra illeszkedik: a `pelda.com` engedi a `shop.pelda.com`-ot, de nem engedi az `evilpelda.com`-ot.
  - Ha a fájl hiányzik vagy üres, egy hoszt sincs engedélyezve.
  - A lista tartalma Péter döntése.
- **URL-alak:** http/https, alapport, userinfo nélkül, DNS-név (nem IP).
- **Címek:** a név minden feloldott címe nyilvános kell legyen. Loopback, privát, link-local, CGNAT vagy multicast cím esetén a kérés el sem indul.
- **Átirányítás:** csak `follow: true`-ra követi, legfeljebb 5 lépést, és minden lépés újra átmegy a fenti ellenőrzéseken.
- **Törzs és idő:** a törzsből legfeljebb 1 MiB-ot olvas, egy kérés legfeljebb 15 s.
- **Ki hívhatja:** dashboard-token vagy session. Föderációs társ és eszközkulcs 403-at kap.
- **Napló és sebességkorlát:** minden mérés naplózódik a hívó `X-Agent-Id`-jével, és percenként legfeljebb 30 mérés mehet.

**Ami nincs lefedve:** ha egy név feloldása az ellenőrzés és a kapcsolódás között megváltozik (DNS rebinding), a második feloldás nem ellenőrzött. Az elsődleges védelem az engedélyezett hosztok listája, a címellenőrzés csak második kerítés.
