# Praxis-Routenplaner

Rundtouren zu Hausarzt- und Physiopraxen rund um den Betriebssitz, zum
Abfahren, Abhaken und Protokollieren. Gebaut für Vor-Ort-Akquise von
Krankenfahrten.

Zwei Teile, getrennt deploybar:

| Teil | Wo | Was |
|---|---|---|
| `backend/` | Railway | Praxen importieren, Route rechnen, Besuche speichern |
| `frontend/` | Netlify | Oberfläche fürs Handy, funktioniert auch offline |

---

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

## Deploy: Backend auf Railway

1. Neuen Dienst aus diesem Repository anlegen.
2. **Settings → Root Directory: `routenplaner/backend`.**
   Ohne das nimmt Railway das Dockerfile im Wurzelverzeichnis (das ist der
   Leadgen-Server, ein anderes Projekt).
3. **Volume anlegen und mounten**, z. B. auf `/data`. Railway setzt dann
   `RAILWAY_VOLUME_MOUNT_PATH` selbst, und das Backend legt die Datenbank
   dorthin. *Ohne Volume sind nach jedem Deploy alle Häkchen und Notizen weg* —
   das Backend schreibt beim Start eine Warnung ins Log, wenn es kein Volume
   findet.
4. Variablen setzen (siehe `backend/.env.example`), mindestens:
   - `APP_PASSWORT` — sonst kann jeder mit der URL mitlesen und mitschreiben
   - `HTTP_USER_AGENT` — mit echter Kontaktadresse, Nominatim verlangt das
   - `START_ADRESSE` — lässt sich später in der App ändern
5. `PORT` **nicht** setzen, das macht Railway selbst.

Prüfen: `https://<dienst>.up.railway.app/health` muss `{"ok":true,…}` liefern.

## Deploy: Frontend auf Netlify

1. Neue Site aus demselben Repository.
2. **Base directory: `routenplaner/frontend`**, **Build command leer**,
   **Publish directory: `routenplaner/frontend`**.
3. Fertig — es gibt keinen Buildschritt und keine Abhängigkeiten.

**Backend-Adresse einmalig festnageln:** In `frontend/config.js` die Railway-
Adresse bei `backendUrl` eintragen, committen, pushen. Dann startet die Seite
direkt mit der Tour und fragt nie wieder danach. Bleibt das Feld leer, fragt
die App beim ersten Öffnen auf jedem Gerät einmal.

Ein Passwort braucht es nur, wenn im Backend `APP_PASSWORT` gesetzt ist; im
Einrichtungsdialog ist das Feld deshalb weggeklappt. Trägt man es in
`config.js` ein, steht es im öffentlichen Quelltext der Seite — dann schützt
nur noch die Unkenntnis der Netlify-Adresse. Wer das nicht will, lässt es leer
und gibt es einmal pro Handy ein.

## Vorschau ohne Backend

Die veröffentlichte Seite zeigt **nur echte Daten**: in `config.js` steht
`demoErlauben: false`. Ohne erreichbares Backend bleibt sie leer und sagt,
dass keines verbunden ist — damit niemand versehentlich eine erfundene Praxis
abklappert.

Zum Anschauen ohne Railway lässt sich `demoErlauben` kurz auf `true` stellen.
Dann läuft die komplette Oberfläche mit Beispieldaten: Tagesliste, Karte,
Detailansicht, Abhaken, Notizen. Die Praxen darin sind **erfunden** (ein
Banner sagt das dauerhaft), die Tour selbst ist echt gerechnet — dieselbe
Gruppierung, dieselbe Reihenfolgeoptimierung wie im Betrieb. Abgehaktes bleibt
im Browser.

Sobald `backendUrl` gesetzt ist, spielt die Einstellung keine Rolle mehr: eine
konfigurierte Adresse schlägt die Vorschau immer, auch auf einem Gerät, das
vorher in der Vorschau war.

---

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
npm test                 # 59 Tests, ohne Netz
APP_PASSWORT=test npm run dev

# in einem zweiten Terminal:
cd routenplaner/frontend
npx http-server . -p 4178
# http://127.0.0.1:4178 öffnen, Backend http://127.0.0.1:4100 eintragen
```

Die Tests decken Geometrie, Einordnung der OSM- und Google-Tags,
Adressgruppierung, Dublettenerkennung, Tagesaufteilung, Reihenfolge-
Optimierung, Besuchsprotokolle und einen kompletten Tourdurchlauf ab.
Netzaufrufe zu Overpass, Nominatim und OSRM sind bewusst nicht getestet — das
wären Tests gegen fremde, gedrosselte Dienste und damit keine Tests.
