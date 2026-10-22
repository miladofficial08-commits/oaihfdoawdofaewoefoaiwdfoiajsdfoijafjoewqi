# Praxis-Routenplaner

Rundtouren zu Hausarzt- und Physiopraxen rund um den Betriebssitz, zum
Abfahren, Abhaken und Protokollieren. Gebaut für Vor-Ort-Akquise von
Krankenfahrten.

**Alles auf Netlify, kein zweiter Dienst nötig.** Die Seite und die API liegen
unter derselben Adresse; den Speicher stellt Netlify Blobs. Railway wird nicht
gebraucht — der Server dafür liegt weiterhin bei, falls du lieber einen
eigenen betreibst.

| Ordner | Was | Wo |
|---|---|---|
| `frontend/` | Oberfläche fürs Handy, offlinefähig | Netlify (statisch) |
| `netlify/functions/` | die API: Import, Tourbau, Besuche | Netlify Functions + Blobs |
| `shared/` | die eigentliche Logik — beide Varianten nutzen dieselbe | — |
| `backend/` | Alternative: eigener Server mit SQLite | Railway (optional) |

## Was das System macht

1. **Praxen einsammeln** im einstellbaren Umkreis um den Betrieb — aus
   OpenStreetMap, optional zusätzlich aus Google Places.
2. **Zu Stopps gruppieren**: Ein Stopp ist eine *Adresse*, keine Praxis. Im
   Ärztehaus hält man einmal und klingelt oben an vier Türen.
3. **In Tagestouren schneiden**: Die Stopps werden nach Kompassrichtung vom
   Betrieb aus sortiert und in gleich große Blöcke geteilt. Jeder Tag wird
   dadurch ein Tortenstück — kompakt, kein Kreuz-und-quer.
4. **Reihenfolge optimieren**: Nächster Nachbar, danach 2-opt und Or-opt auf
   echten Fahrzeiten (OSRM). Jeder Tag beginnt und endet am Betrieb.
5. **Im Feld abhaken**: Status, Ansprechpartner, Potenzial, Notiz,
   Wiedervorlage. Ohne Netz geht das auch — es wird nachgereicht.
6. **Unterwegs neu sortieren**: „Ab hier neu sortieren" nimmt den aktuellen
   GPS-Standort, lässt alles Erledigte liegen und ordnet den Rest so, dass man
   am Ende wieder zu Hause ankommt.

---

## Deploy auf Netlify

Ein Dienst, fertig:

1. Neue Site aus diesem Repository.
2. **Branch to deploy:** `claude/practical-thompson-t49wh4`
3. **Base directory:** `routenplaner`
4. **Build command:** `npm install`
5. **Publish directory:** `routenplaner/frontend`
6. Deployen. Die Funktionen unter `netlify/functions` werden automatisch
   mitgebaut und liegen danach unter `/api`.

Optional als Umgebungsvariablen (Site configuration → Environment variables):

| Variable | Wofür |
|---|---|
| `APP_PASSWORT` | gemeinsames Passwort; ohne ist die API für jeden offen, der die Adresse kennt |
| `HTTP_USER_AGENT` | eigene Kontaktadresse — Nominatim verlangt das |
| `START_ADRESSE` | Betriebssitz, in der App überschreibbar |
| `GOOGLE_PLACES_KEY` | statt der Eingabe in der App |
| `OSRM_BASE` | eigener Routing-Server statt des Demo-Servers |

**Netlify Blobs** muss nicht eingerichtet werden; der Speicher gehört zur Site
und ist ohne Zutun da. Anders als beim Railway-Volume kann hier nichts
schiefgehen: Besuchsprotokolle überleben jedes Deploy.

### Wenn `/api` nichts beantwortet

Dann sagt die Seite das auch und erfindet nichts. Nachsehen in Netlify unter
**Deploys → (letztes Deploy) → Deploy log**, ob die Funktionen gebaut wurden,
und unter **Logs → Functions**, ob sie beim Aufruf abstürzen.

## Alternative: eigener Server auf Railway

Nur nötig, wenn du den Speicher selbst in der Hand haben willst.

1. **Root Directory:** `routenplaner` (nicht `routenplaner/backend`), denn der
   Build braucht auch `shared/`. **Dockerfile-Pfad:** `backend/Dockerfile`.
2. **Volume anlegen und mounten**, z. B. auf `/data`. *Ohne Volume sind nach
   jedem Deploy alle Häkchen und Notizen weg* — das Backend warnt beim Start.
3. Variablen aus `backend/.env.example` setzen, mindestens `APP_PASSWORT` und
   `HTTP_USER_AGENT`. `PORT` **nicht** setzen, das macht Railway.
4. In `frontend/config.js` die Railway-Adresse bei `backendUrl` eintragen —
   damit spricht die Seite diesen Server an statt der Netlify-Funktionen.

Prüfen: `https://<dienst>.up.railway.app/health` muss `{"ok":true,…}` liefern.

## Erster Lauf

Der kurze Weg: **Daten → Alles generieren**. Dort Google-Schlüssel eintragen
(optional), Umkreis und Stopps pro Tag setzen, **Generieren** drücken. Das
setzt den Startpunkt, lädt die Praxen und baut die Tour in einem Durchgang;
am Ende springt die App in die Tour-Ansicht.

**Vorher einmal den Testlauf anhaken.** Der nimmt 1,5 km Umkreis und ein
grobes Raster — bei Google ein paar Cent statt zweistelliger Beträge. Wenn da
eine plausible Tour herauskommt, funktioniert die ganze Kette, und der große
Lauf ist kein Blindflug.

Den Google-Schlüssel kann man entweder in Railway als `GOOGLE_PLACES_KEY`
setzen oder direkt in der App eintragen. Der eingetragene gewinnt. Beim
Speichern macht das Backend **eine** Probeanfrage und sagt sofort, ob der
Schlüssel funktioniert — statt dass ein Lauf über hunderte Anfragen an einem
Tippfehler scheitert. Der Schlüssel wird nie wieder herausgegeben, die API
zeigt nur die letzten vier Zeichen.

Wer die Schritte einzeln steuern will, findet sie darunter weiterhin als
„Praxen laden" und „Tour bauen".

Im Auto:
- **Navigation** öffnet Google Maps für den einzelnen Stopp.
- **Tag in Google Maps** legt bis zu neun offene Stopps auf einmal rein (mehr
  nimmt Google in einem Link nicht an — die App sagt es, wenn sie abschneidet).
- **Standort holen** → **Ab hier neu sortieren**, wenn man die Reihenfolge
  verlassen hat.

---

## Was das System nicht kann — bitte vorher lesen

**Die Praxisliste ist nicht garantiert vollständig.**
OpenStreetMap wird von Freiwilligen gepflegt. In deutschen Städten sind
Arztpraxen gut, aber nicht lückenlos erfasst. Realistisch findet man damit
einen großen Teil der Praxen, nicht alle — und bei einem Teil der gefundenen
fehlen Telefonnummer oder Fachrichtung. Wer eine Stichprobe macht („kennt es
Praxis X?"), wird Lücken finden.

Dagegen hilft der **Google-Places-Import**: Praktisch jede Praxis mit
Google-Profil taucht dort auf. Das kostet Geld — bei 6 km Umkreis und 700 m
Raster rund 435 Anfragen, grob 13–15 USD nach Listenpreis. Die App rechnet die
Zahl vor dem Start aus und fragt bei einem kostenpflichtigen Lauf noch einmal
nach. Beide Quellen werden über Adresse und Name zusammengeführt, es entstehen
keine Dubletten.

Damit der Schlüssel serverseitig funktioniert, muss im Google-Cloud-Projekt
die **Places API (New)** aktiviert sein, und der Schlüssel darf **nicht** auf
HTTP-Referrer beschränkt sein (das ist eine Browser-Beschränkung; die Anfragen
kommen hier vom Server). „Keine Beschränkung" oder eine IP-Beschränkung
funktionieren. Sinnvoll ist es, den Schlüssel auf die Places API zu begrenzen
und ein Tageslimit zu setzen.

**Noch nicht vollständig: die amtliche Quelle.** Die lückenloseste Liste der
Hausärzte ist die Arztsuche der KV Nordrhein (116117) — dort ist jede Praxis
registriert, die Krankenfahrten überhaupt verordnen darf. Dieser Import ist
noch nicht eingebaut.

Kommt die Meldung „*n* Zellen waren mit 20 Treffern voll", war das Raster zu
grob: dort hat Google mehr, als eine Anfrage zurückgibt. Dann mit 400 m noch
einmal laufen lassen.

**Fachrichtungen stimmen nicht immer.**
Steht in OpenStreetMap keine Fachrichtung, landet die Praxis in
„Arztpraxis (Fachrichtung nicht hinterlegt)" — bewusst standardmäßig
eingeschaltet, weil darunter sehr viele Hausärzte stecken. Ein zu Unrecht
mitgenommener Stopp kostet fünf Minuten, ein übersehener Hausarzt den Auftrag.

**Die Route ist gut, nicht beweisbar optimal.**
Das exakte Rundreiseproblem zu lösen lohnt bei 15–25 Stopps nicht. Das
Verfahren hier liegt erfahrungsgemäß wenige Prozent darüber und rechnet in
Millisekunden.

**Der Routing-Dienst ist der öffentliche OSRM-Demo-Server.**
Gratis, aber ohne Zusage: Er drosselt, ist manchmal weg, und nimmt höchstens
100 Punkte pro Matrix. Fällt er aus, rechnet das System mit Luftlinie
(× 1,35 Umwegfaktor, 24 km/h Stadttempo) weiter und schreibt „Luftlinie" in
die Kopfzeile. Die Tour ist dann etwas schlechter sortiert, aber sie
existiert. Für Dauerbetrieb lohnt ein eigener OSRM-Container, dann fallen
Drosselung und Größengrenze weg (`OSRM_BASE`).

**Öffnungszeiten werden nicht geprüft.**
Wo OpenStreetMap welche kennt, stehen sie am Stopp — verlassen sollte man sich
nicht darauf. Mittwochnachmittag ist in vielen Hausarztpraxen zu.

---

## Kategorien

| Kategorie | Standardmäßig an | Warum |
|---|---|---|
| Hausarzt / Allgemeinmedizin | ja | verordnet Krankenfahrten am häufigsten |
| Physiotherapie | ja | kennt die Patienten, die regelmäßig gefahren werden |
| Arztpraxis ohne Fachrichtung | ja | darunter viele Hausärzte |
| Ärztehaus / MVZ / Klinik | ja | ein Halt, mehrere Praxen |
| Dialyse, Onkologie, Strahlentherapie | ja | **nicht erfragt, aber die größten Dauerauftraggeber**: Patienten fahren 2–3× pro Woche |
| Sonstige Facharztpraxen | nein | Zahnarzt, Augenarzt — selten Krankenfahrten |
| Pflegeheime / Pflegedienste | nein | starke Quelle, aber ein anderes Gespräch |

---

## Besuchsstatus

`offen` · `besucht` · `nochmal hin` · `kein Interesse` · `war zu`

Dazu je Praxis: Ansprechpartner, Potenzial (hoch/mittel/gering), Notiz,
„Flyer dagelassen", Wiedervorlagedatum und wer es eingetragen hat. Jede
Änderung landet zusätzlich im Verlauf, nichts wird überschrieben und
vergessen. Ein erneuter Import löscht **nie** einen Besuchsstand.

---

## Offline

Die Tour wird im Handy gespiegelt. Abhaken funktioniert ohne Netz: Änderungen
gehen in eine Warteschlange (im Kopf sichtbar als „*n* warten") und werden
gesendet, sobald wieder Empfang da ist — spätestens beim nächsten Öffnen der
App. Zwei Handys sehen sich gegenseitig, sobald beide gesendet haben.

---

## API

Alle Pfade außer `/health` und `/api/info` brauchen den Kopf
`X-Passwort: <APP_PASSWORT>`, sofern gesetzt.

| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/health` | Lebenszeichen für Railway |
| GET | `/api/info` | Kategorien, Statuswerte, Vorgaben |
| GET | `/api/statistik` | Zahlen zu Praxen, Besuchen, aktueller Tour |
| GET/POST | `/api/start` | Betriebssitz lesen / setzen (Adresse oder lat/lon) |
| POST | `/api/generieren` | Startpunkt, Import und Tourbau in einem Durchgang |
| GET/POST | `/api/google-key` | Schlüsselstand lesen / setzen / entfernen (nie im Klartext zurück) |
| POST | `/api/google-key/pruefen` | Eine Probeanfrage, um den Schlüssel zu testen |
| POST | `/api/import` | Import starten (läuft im Hintergrund) |
| GET | `/api/import/status` | Fortschritt und Meldungen |
| GET | `/api/import/kosten` | Google-Anfragen und grobe Kostenschätzung |
| GET | `/api/praxen` | Praxen, filterbar nach Kategorie, Radius, Status |
| GET | `/api/praxen/:id` | Einzelne Praxis samt Verlauf |
| PATCH | `/api/besuche/:id` | Besuchsstand ändern |
| POST | `/api/besuche/sammel` | Stapel aus der Offline-Warteschlange |
| GET | `/api/tour` | Aktuelle Tour mit tagesaktuellem Stand |
| POST | `/api/tour/bauen` | Tour neu bauen |
| POST | `/api/tour/weiter` | Rest des Tages ab aktuellem Standort neu ordnen |
| GET | `/api/export.csv` | Alles als CSV (Excel-tauglich, mit BOM) |

---

## Lokal entwickeln

```bash
cd routenplaner/backend
npm install
npm test                 # 70 Tests, ohne Netz
APP_PASSWORT=test npm run dev

# in einem zweiten Terminal:
cd routenplaner/frontend
npx http-server . -p 4178
# http://127.0.0.1:4178 öffnen, Backend http://127.0.0.1:4100 eintragen
```

Die Tests decken Geometrie, Einordnung der OSM- und Google-Tags,
Adressgruppierung, Dublettenerkennung, Tagesaufteilung, Reihenfolge-
Optimierung, Besuchsprotokolle und einen kompletten Tourdurchlauf ab — und
zwar für beide Speicher-Varianten: die SQL-Fassung und die JSON-Fassung, die
auf Netlify läuft. Laufen die beiden auseinander, fällt es dort sofort auf.

Die Netlify-Funktionen selbst (`netlify/functions/`) sind typgeprüft, aber
nicht zur Laufzeit getestet — dafür bräuchte es eine echte Netlify-Umgebung.
Die Logik, die sie aufrufen, liegt in `shared/` und ist getestet; die
Funktionen selbst lesen, rufen auf und schreiben.
Netzaufrufe zu Overpass, Nominatim und OSRM sind bewusst nicht getestet — das
wären Tests gegen fremde, gedrosselte Dienste und damit keine Tests.
