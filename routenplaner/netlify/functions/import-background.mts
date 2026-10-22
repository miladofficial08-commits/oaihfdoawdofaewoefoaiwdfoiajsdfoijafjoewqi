// Der lange Lauf: Praxen einsammeln und direkt die Tour bauen.
//
// Warum eine eigene Funktion: Overpass braucht je nach Last ein bis drei
// Minuten, mit Google-Zusatz deutlich länger. Synchrone Netlify-Funktionen
// haben 60 Sekunden, Hintergrundfunktionen 15 Minuten. Der Aufrufer bekommt
// sofort ein 202 und fragt den Fortschritt über /api/import/status ab, der
// aus dem Speicher gelesen wird.
//
// Ein Lauf gleichzeitig: zwei parallele Importe kämen sich beim
// Zusammenführen in die Quere.

import type { Context } from '@netlify/functions';
import { diensteAusUmgebung } from '../../shared/dienste';
import { geokodieren } from '../../shared/nominatim';
import { osmImport } from '../../shared/overpass';
import { placesImport } from '../../shared/places';
import { zusammenfuehren, zusammenstellen } from '../../shared/praxen-logik';
import { tourBauenAus } from '../../shared/tour-bauen';
import { istKategorie, STANDARD_KATEGORIEN } from '../../shared/typen';
import {
  aendere, besucheLesen, einstellungenLesen, praxenLesen, schreib, speicher,
  SCHLUESSEL, type Einstellungen,
} from './_speicher.mjs';

const dienste = diensteAusUmgebung(process.env);

interface Stand {
  laeuft: boolean;
  phase: string;
  meldungen: string[];
  gefunden: number;
  neu: number;
  aktualisiert: number;
  zusammengefuehrt: number;
  google_anfragen: number;
  fehler: string[];
  gestartet?: string;
  fertig?: string;
  tour?: { tage: number; stopps: number; strecke_m: number; fahrzeit_s: number } | null;
}

export default async (req: Request, _context: Context) => {
  const store = speicher();
  const körper = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const vorher = (await store.get(SCHLUESSEL.importStand, { type: 'json' })) as Stand | null;
  if (vorher?.laeuft) return; // schon unterwegs

  const testlauf = körper.testlauf === true;
  const radiusKm = testlauf ? 1.5 : zahl(körper.radiusKm, 6, 0.5, 30);
  const zellRadiusM = testlauf ? 1000 : zahl(körper.zellRadiusM, 700, 200, 3000);
  const mitGoogle = körper.mitGoogle === true;
  const kategorien = ((körper.kategorien as string[]) ?? STANDARD_KATEGORIEN).filter(istKategorie);
  const stoppsProTag = zahl(körper.stoppsProTag, 18, 3, 60);

  const stand: Stand = {
    laeuft: true, phase: 'startet', meldungen: [], gefunden: 0, neu: 0,
    aktualisiert: 0, zusammengefuehrt: 0, google_anfragen: 0, fehler: [],
    gestartet: new Date().toISOString(), tour: null,
  };

  // Der Fortschritt wird nicht bei jeder Meldung geschrieben — das wären
  // hunderte Schreibvorgänge. Einmal pro Sekunde reicht für eine Anzeige,
  // die ohnehin alle zwei Sekunden abgefragt wird.
  let zuletztGeschrieben = 0;
  const sichern = async (erzwingen = false) => {
    const jetzt = Date.now();
    if (!erzwingen && jetzt - zuletztGeschrieben < 1000) return;
    zuletztGeschrieben = jetzt;
    await schreib(store, SCHLUESSEL.importStand, {
      ...stand, meldungen: stand.meldungen.slice(-25), fehler: stand.fehler.slice(-15),
    });
  };
  const melde = (text: string) => {
    stand.meldungen.push(`${new Date().toISOString().slice(11, 19)} ${text}`);
    stand.phase = text;
    console.log(`[import] ${text}`);
    void sichern();
  };

  await sichern(true);

  try {
    // ── Startpunkt ─────────────────────────────────────────────────────────
    if (typeof körper.startAdresse === 'string' && körper.startAdresse.trim()) {
      melde(`Startadresse geokodieren: ${körper.startAdresse}`);
      try {
        const treffer = await geokodieren(körper.startAdresse.trim(), dienste);
        if (treffer) {
          await aendere<Einstellungen>(store, SCHLUESSEL.einstellungen, {}, alt => ({
            ...alt,
            start_adresse: treffer.anzeigename,
            start_lat: treffer.lat,
            start_lon: treffer.lon,
            start_quelle: 'geokodiert',
          }));
          melde(`Startpunkt: ${treffer.anzeigename}`);
        } else {
          stand.fehler.push(`Adresse nicht gefunden: ${körper.startAdresse}`);
        }
      } catch (err) {
        // Weitermachen mit dem alten Sitz ist besser als abbrechen – aber der
        // Fehler muss sichtbar bleiben, sonst sucht man ihn in der Route.
        stand.fehler.push(`Geocoding fehlgeschlagen: ${text(err)}`);
        melde('Geocoding fehlgeschlagen – bisheriger Startpunkt bleibt.');
      }
    }

    const einst = await einstellungenLesen(store);
    const sitz = {
      adresse: einst.start_adresse || process.env.START_ADRESSE || 'Dillenburger Weg 17, 40229 Düsseldorf',
      lat: einst.start_lat ?? Number(process.env.START_LAT || 51.2033),
      lon: einst.start_lon ?? Number(process.env.START_LON || 6.8419),
      quelle: einst.start_quelle || 'fallback',
    };
    melde(`Suche im Radius ${radiusKm} km um ${sitz.adresse}`);

    // ── OpenStreetMap ──────────────────────────────────────────────────────
    const osm = await osmImport(sitz, radiusKm, dienste, melde);
    for (const g of osm.gruppen) if (g.fehler) stand.fehler.push(`OSM ${g.name}: ${g.fehler}`);
    stand.gefunden += osm.praxen.length;
    melde(`OpenStreetMap: ${osm.praxen.length} Einrichtungen`);

    let bestand = await praxenLesen(store);
    const bilanzOsm = zusammenfuehren(bestand, osm.praxen, sitz);
    bestand = bilanzOsm.bestand;
    stand.neu += bilanzOsm.bilanz.neu;
    stand.aktualisiert += bilanzOsm.bilanz.aktualisiert;
    stand.zusammengefuehrt += bilanzOsm.bilanz.zusammengefuehrt;
    await schreib(store, SCHLUESSEL.praxen, bestand);
    melde(`OpenStreetMap gespeichert: ${bilanzOsm.bilanz.neu} neu, ${bilanzOsm.bilanz.aktualisiert} aufgefrischt`);

    // ── Google Places ──────────────────────────────────────────────────────
    const schluessel = einst.google_key || process.env.GOOGLE_PLACES_KEY || '';
    if (mitGoogle) {
      if (!schluessel) {
        stand.fehler.push('Google-Import angefordert, aber es ist kein Schlüssel hinterlegt.');
        melde('Google übersprungen: kein Schlüssel hinterlegt.');
      } else {
        melde('Google Places: Lauf beginnt (kostenpflichtig)');
        const google = await placesImport(sitz, radiusKm, schluessel, zellRadiusM, melde);
        stand.google_anfragen = google.anfragen;
        stand.gefunden += google.praxen.length;
        for (const f of google.fehler) stand.fehler.push(`Google: ${f}`);
        const bilanzGoogle = zusammenfuehren(bestand, google.praxen, sitz);
        bestand = bilanzGoogle.bestand;
        stand.neu += bilanzGoogle.bilanz.neu;
        stand.aktualisiert += bilanzGoogle.bilanz.aktualisiert;
        stand.zusammengefuehrt += bilanzGoogle.bilanz.zusammengefuehrt;
        await schreib(store, SCHLUESSEL.praxen, bestand);
        melde(
          `Google: ${google.praxen.length} Treffer aus ${google.anfragen} Anfragen, ` +
            `${bilanzGoogle.bilanz.neu} neu, ${bilanzGoogle.bilanz.zusammengefuehrt} zusammengeführt`,
        );
      }
    }

    // ── Tour ───────────────────────────────────────────────────────────────
    melde('Tour wird gebaut …');
    try {
      const besuche = await besucheLesen(store);
      const params = { kategorien, radiusKm, stoppsProTag };
      const gefiltert = zusammenstellen(bestand, besuche, {
        kategorien,
        maxEntfernungM: Math.round(radiusKm * 1000),
      });
      const ergebnis = await tourBauenAus(gefiltert, sitz, params, dienste);
      await schreib(store, SCHLUESSEL.tour, {
        erstellt_am: new Date().toISOString(),
        start: sitz,
        params,
        strecke_m: ergebnis.strecke_m,
        fahrzeit_s: ergebnis.fahrzeit_s,
        matrix_quelle: ergebnis.matrix_quelle,
        hinweise: ergebnis.hinweise,
        tage: ergebnis.tage.map(t => ({
          tag: t.tag, strecke_m: t.strecke_m, fahrzeit_s: t.fahrzeit_s,
          rueckweg_m: t.rueckweg_m, rueckweg_s: t.rueckweg_s, geometrie: t.geometrie,
          stopps: t.stopps.map(s => ({
            adress_key: s.adress_key, lat: s.lat, lon: s.lon,
            position: s.position, strecke_m: s.strecke_m, fahrzeit_s: s.fahrzeit_s,
          })),
        })),
      });
      stand.tour = {
        tage: ergebnis.tage.length,
        stopps: ergebnis.tage.reduce((n, t) => n + t.stopps.length, 0),
        strecke_m: ergebnis.strecke_m,
        fahrzeit_s: ergebnis.fahrzeit_s,
      };
      for (const h of ergebnis.hinweise) stand.fehler.push(h);
      melde(
        `Tour fertig: ${stand.tour.tage} Tage, ${stand.tour.stopps} Stopps, ` +
          `${(stand.tour.strecke_m / 1000).toFixed(1)} km`,
      );
    } catch (err) {
      // Der Import war erfolgreich – das darf eine fehlgeschlagene
      // Tourberechnung nicht entwerten. Die Praxen sind gespeichert.
      stand.fehler.push(`Tourbau fehlgeschlagen: ${text(err)}`);
      melde(
        stand.gefunden > 0
          ? 'Praxen sind da, aber der Tourbau ist fehlgeschlagen.'
          : 'Keine Praxen eingesammelt – deshalb konnte auch keine Tour entstehen.',
      );
    }

    melde(
      stand.gefunden === 0 && stand.fehler.length > 0
        ? 'Durchgang beendet, aber es kam nichts an – siehe Fehler oben.'
        : 'fertig',
    );
  } catch (err) {
    stand.fehler.push(text(err));
    stand.phase = 'abgebrochen';
  } finally {
    stand.laeuft = false;
    stand.fertig = new Date().toISOString();
    await sichern(true);
  }
};

function text(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function zahl(wert: unknown, standard: number, min: number, max: number): number {
  const n = Number(wert);
  if (!Number.isFinite(n)) return standard;
  return Math.min(max, Math.max(min, n));
}
