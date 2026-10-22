// Import als Hintergrundlauf.
//
// Grund: Ein Durchlauf über Overpass dauert je nach Last eine halbe bis
// mehrere Minuten, mit Google-Zusatz deutlich länger. Als HTTP-Request würde
// das in jedem Proxy timeouten. Deshalb: Start liefert sofort zurück, die
// Oberfläche fragt den Fortschritt ab.
//
// Es läuft bewusst nur ein Import gleichzeitig — zwei parallele Läufe würden
// sich beim Zusammenführen gegenseitig in die Quere kommen.

import { dienste } from './config';
import { googleSchluessel } from './google-key';
import { praxenSpeichern } from './praxen-repo';
import { osmImport } from '../../shared/overpass';
import { placesImport } from '../../shared/places';
import {
  betriebssitzLesen,
  betriebssitzSetzen,
  tourBauen,
  type TourBauParams,
} from './routing/tour';

export interface ImportFortschritt {
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
  /** Ergebnis des angehängten Tourbaus, falls einer angefordert war. */
  tour?: { tage: number; stopps: number; strecke_m: number; fahrzeit_s: number } | null;
}

const stand: ImportFortschritt = {
  laeuft: false,
  phase: 'bereit',
  meldungen: [],
  gefunden: 0,
  neu: 0,
  aktualisiert: 0,
  zusammengefuehrt: 0,
  google_anfragen: 0,
  fehler: [],
  tour: null,
};

export function importFortschritt(): ImportFortschritt {
  // Nur die letzten Meldungen – die Liste wird sonst bei Google-Läufen lang.
  return { ...stand, meldungen: stand.meldungen.slice(-25), fehler: stand.fehler.slice(-15) };
}

function melde(text: string): void {
  stand.meldungen.push(`${new Date().toISOString().slice(11, 19)} ${text}`);
  stand.phase = text;
  console.log(`[import] ${text}`);
}

export interface ImportParams {
  radiusKm: number;
  /** Zusätzlich Google Places abfragen (kostet Geld, braucht Schlüssel). */
  mitGoogle: boolean;
  /** Zellradius für den Google-Lauf in Metern; kleiner = genauer = teurer. */
  zellRadiusM: number;
  /** Startadresse neu geokodieren, falls angegeben. */
  startAdresse?: string;
  /**
   * Wenn gesetzt, wird direkt im Anschluss die Tour gebaut. Das ist der
   * "Generieren"-Knopf: ein Druck, und am Ende steht eine fahrbare Tour,
   * statt dass man nach dem Import noch einen zweiten Schritt auslösen muss.
   */
  tour?: TourBauParams;
}

export function importStarten(params: ImportParams): ImportFortschritt {
  if (stand.laeuft) return importFortschritt();
  Object.assign(stand, {
    laeuft: true,
    phase: 'startet',
    meldungen: [],
    gefunden: 0,
    neu: 0,
    aktualisiert: 0,
    zusammengefuehrt: 0,
    google_anfragen: 0,
    fehler: [],
    tour: null,
    gestartet: new Date().toISOString(),
    fertig: undefined,
  });

  // Absichtlich nicht awaiten: der Aufrufer bekommt sofort eine Antwort.
  void lauf(params).catch(err => {
    stand.fehler.push(err instanceof Error ? err.message : String(err));
    stand.laeuft = false;
    stand.phase = 'abgebrochen';
    stand.fertig = new Date().toISOString();
  });

  return importFortschritt();
}

async function lauf(params: ImportParams): Promise<void> {
  try {
    if (params.startAdresse) {
      melde(`Startadresse geokodieren: ${params.startAdresse}`);
      try {
        const sitz = await betriebssitzSetzen(params.startAdresse);
        melde(`Startpunkt: ${sitz.adresse} (${sitz.lat.toFixed(5)}, ${sitz.lon.toFixed(5)})`);
      } catch (err) {
        // Weitermachen mit dem alten Sitz ist besser als abbrechen – aber der
        // Fehler muss sichtbar bleiben, sonst sucht man ihn in der Route.
        stand.fehler.push(
          `Geocoding fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`,
        );
        melde('Geocoding fehlgeschlagen – bisheriger Startpunkt bleibt.');
      }
    }

    const sitz = betriebssitzLesen();
    melde(`Suche im Radius ${params.radiusKm} km um ${sitz.adresse}`);

    const osm = await osmImport(sitz, params.radiusKm, dienste, melde, zwischen => {
      stand.gefunden = zwischen.gefunden;
    });
    for (const g of osm.gruppen) {
      if (g.fehler) stand.fehler.push(`OSM ${g.name}: ${g.fehler}`);
    }
    stand.gefunden = osm.praxen.length;
    melde(`OpenStreetMap: ${osm.praxen.length} Einrichtungen gefunden`);
    const bilanzOsm = praxenSpeichern(osm.praxen, sitz);
    stand.neu += bilanzOsm.neu;
    stand.aktualisiert += bilanzOsm.aktualisiert;
    stand.zusammengefuehrt += bilanzOsm.zusammengefuehrt;
    melde(
      `OpenStreetMap gespeichert: ${bilanzOsm.neu} neu, ${bilanzOsm.aktualisiert} aufgefrischt`,
    );

    if (params.mitGoogle) {
      if (!googleSchluessel()) {
        stand.fehler.push(
          'Google-Import angefordert, aber es ist kein Schlüssel hinterlegt.',
        );
        melde('Google übersprungen: kein Schlüssel hinterlegt.');
      } else {
        melde('Google Places: Lauf beginnt (kostenpflichtig)');
        const google = await placesImport(
          sitz,
          params.radiusKm,
          googleSchluessel(),
          params.zellRadiusM,
          melde,
        );
        stand.google_anfragen = google.anfragen;
        stand.gefunden += google.praxen.length;
        for (const f of google.fehler) stand.fehler.push(`Google: ${f}`);
        melde(
          `Google Places: ${google.praxen.length} Treffer aus ${google.anfragen} Anfragen` +
            (google.volle_zellen > 0 ? `, ${google.volle_zellen} Zellen voll` : ''),
        );
        const bilanzGoogle = praxenSpeichern(google.praxen, sitz);
        stand.neu += bilanzGoogle.neu;
        stand.aktualisiert += bilanzGoogle.aktualisiert;
        stand.zusammengefuehrt += bilanzGoogle.zusammengefuehrt;
        melde(
          `Google gespeichert: ${bilanzGoogle.neu} neu, ${bilanzGoogle.zusammengefuehrt} mit OSM-Einträgen zusammengeführt`,
        );
      }
    }

    if (params.tour) {
      melde('Tour wird gebaut …');
      try {
        const tour = await tourBauen(params.tour);
        stand.tour = {
          tage: tour.tage.length,
          stopps: tour.tage.reduce((n, t) => n + t.stopps.length, 0),
          strecke_m: tour.strecke_m,
          fahrzeit_s: tour.fahrzeit_s,
        };
        for (const h of tour.hinweise) stand.fehler.push(h);
        melde(
          `Tour fertig: ${stand.tour.tage} Tage, ${stand.tour.stopps} Stopps, ` +
            `${(stand.tour.strecke_m / 1000).toFixed(1)} km`,
        );
      } catch (err) {
        // Der Import war erfolgreich – das darf eine fehlgeschlagene
        // Tourberechnung nicht entwerten. Die Praxen sind gespeichert, die
        // Tour lässt sich einzeln noch einmal auslösen.
        stand.fehler.push(
          `Tourbau fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`,
        );
        melde(
          stand.gefunden > 0
            ? 'Praxen sind da, aber der Tourbau ist fehlgeschlagen.'
            : 'Keine Praxen eingesammelt – deshalb konnte auch keine Tour entstehen.',
        );
      }
    }

    // "fertig" darf nicht dranstehen, wenn nichts ankam. Sonst sucht man den
    // Fehler später in der Tour statt beim Import.
    if (stand.gefunden === 0 && stand.fehler.length > 0) {
      melde('Durchgang beendet, aber es kam nichts an – siehe Fehler oben.');
    } else {
      melde('fertig');
    }
  } finally {
    stand.laeuft = false;
    stand.fertig = new Date().toISOString();
  }
}
