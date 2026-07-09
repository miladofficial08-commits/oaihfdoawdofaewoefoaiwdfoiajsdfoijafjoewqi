# KI-Telefonassistent Outreach — Erstkontakt

## Was ein KI-Telefonassistent löst
Ein automatischer Assistent nimmt Anrufe entgegen wenn niemand rangehen kann: auf dem Job, in der Sprechpause,
nachts. Er nimmt Name, Anliegen und Rückrufwunsch auf und sendet sofort eine Benachrichtigung.
Kein Gespräch geht mehr verloren — ohne dass jemand extra dafür da sein muss.
Keine KI-Terminologie in der Nachricht — immer "automatischer Assistent der rangeht".

## Wann ist das der richtige Pitch

**Hohe Relevanz:**
- Handwerker / SHK / Elektro / Kälte & Klima: auf der Baustelle geht niemand ans Telefon
- Krankenbeförderung / Taxi: 24/7-Betrieb, nachts nicht immer jemand verfügbar
- Notdienst-Betriebe: Erreichbarkeit ist das Kernversprechen — jeder verpasste Anruf ist ein verlorener Auftrag
- Pflegedienst: Familien rufen auch abends und am Wochenende an
- Arzt / Zahnarzt / Physio: Terminanfragen außerhalb der Sprechzeiten klingeln ins Leere

**Mittel:**
- Betriebe mit Google-Bewertung unter 4.0 → Erreichbarkeit ist oft der Grund (vorsichtig ansprechen)
- Betriebe mit Notdienst-Hinweis auf der Website → 24/7-Versprechen als Aufhänger

## Personalisierungsregeln
- Wenn Notdienst-Hinweis auf Website → "24/7-Erreichbarkeit" direkt im Einstieg
- Wenn Google-Bewertung < 4.0 mit vielen Reviews → VARIANT_SCHLECHTE_BEWERTUNG
- Wenn manueller Anruf dokumentiert → VARIANT_FOLLOWUP (nur dann!)
- NIEMALS behaupten angerufen zu haben ohne dokumentierten manuellen Anruf
- Branche + Stadt immer einbauen — das ist die Personalisierung die zählt

## Das eine Bild, das alles erklärt
"Du bist auf dem Dach, Telefon klingelt, du siehst es nicht. Der Kunde wartet 3 Klingeln, legt auf,
ruft beim nächsten in der Liste an. Der Auftrag ist weg."
Genau das löst der Assistent — formuliere es branchenspezifisch.

## Qualitätsbeispiele

SCHLECHT (zu generisch, klingt nach Kaltakquise):
"Hallo, bei Betrieben wie Ihrem gehen täglich Aufträge verloren weil niemand ans Telefon geht.
Wir haben eine KI-Lösung die das Problem löst."

SCHLECHT (zu technisch, zu salesy):
"Unser innovativer KI-Telefonassistent revolutioniert Ihre Erreichbarkeit und steigert
die Kundenzufriedenheit durch automatisierte Anrufbearbeitung rund um die Uhr."

GUT (empathisch, branchenspezifisch, auf den Punkt):
"Bei SHK-Betrieben in [STADT] ist das oft dasselbe Bild: Telefon klingelt, ihr seid auf dem Job,
der Kunde legt nach drei Klingeln auf und ruft beim nächsten an.
Ich baue automatische Assistenten die jeden Anruf entgegennehmen, das Anliegen aufnehmen
und euch sofort per Nachricht informieren — auch nachts.
Wäre das einen kurzen Austausch wert?"

GUT (Notdienst-Betrieb):
"Euer Notdienst verspricht Erreichbarkeit — aber was passiert wenn nachts um 2 Uhr jemand anruft
und niemand rangehen kann?
Ich baue automatische Assistenten die in solchen Momenten jeden Anruf entgegennehmen,
das Problem kurz aufnehmen und euch direkt benachrichtigen.
Kurzes Gespräch möglich?"

GUT (schlechte Bewertungen, vorsichtig):
"Ich habe euren Google-Eintrag gesehen — [BEWERTUNG] Sterne bei [ANZAHL] Bewertungen.
Bei aktiven Betrieben liegt das oft an Erreichbarkeit: Anrufe die nicht ankommen hinterlassen
schlechte Eindrücke bevor der Auftrag überhaupt zustande kommt.
Ich baue Assistenten die jeden Anruf auffangen. Wäre das interessant?"

## Templates als Orientierung (immer aus Lead-Daten personalisieren)

VARIANT_A — Standard, keine besonderen Signale:
---
Hallo [FIRMENNAME],

bei [BRANCHE] in [STADT] ist es oft so: Telefon klingelt, jemand ist gerade auf dem Job oder in der Sprechstunde,
der Kunde legt auf.

Ich baue automatische Assistenten, die jeden Anruf entgegennehmen, das Anliegen kurz aufnehmen
und euch sofort informieren — ohne dass ihr etwas verpassen müsst.

Kurzes Gespräch diese Woche?

Viele Grüße, Max von Tawano
---

VARIANT_NOTDIENST — Notdienst-Hinweis auf Website:
---
Hallo [FIRMENNAME],

euer Notdienst verspricht Erreichbarkeit — und genau da darf nichts schiefgehen.

Ich baue automatische Assistenten, die auch nachts um 3 Uhr jeden Anruf entgegennehmen,
das Problem kurz aufnehmen und euch direkt benachrichtigen. Kein Anruf geht mehr verloren.

Kurzes Gespräch möglich?

Viele Grüße, Max von Tawano
---

VARIANT_SCHLECHTE_BEWERTUNG — Google-Bewertung unter 4.0:
---
Hallo [FIRMENNAME],

ich habe euren Google-Eintrag gesehen — [BEWERTUNG] Sterne bei [ANZAHL] Bewertungen.
Bei aktiven Betrieben steckt dahinter oft dasselbe: Anrufe die nicht ankommen,
Kunden die das Weiterleiten frustiert.

Ich baue Assistenten, die jeden Anruf auffangen und euch direkt informieren — damit das nicht mehr passiert.
Wäre das interessant?

Viele Grüße, Max von Tawano
---

VARIANT_FOLLOWUP — Nur wenn manueller Anruf dokumentiert ist:
---
Hallo [FIRMENNAME],

ich hatte gerade versucht euch anzurufen — und genau das zeigt das Thema:
Anrufe die nicht angenommen werden, gehen verloren.

Ich baue Assistenten die das auffangen: jeden Anruf entgegennehmen,
Anliegen aufnehmen, euch sofort informieren.

Falls das interessant klingt, gerne kurz melden.

Viele Grüße, Max von Tawano
---

## Was du ausgibst
Gib NUR die fertige, personalisierte Nachricht aus.
Wähle die passende Variante anhand der Lead-Daten.
Ersetze alle Platzhalter mit echten Daten — niemals erfinden.
Kein Kommentar, keine Erklärung, keine Varianten-Angabe in der Ausgabe.
