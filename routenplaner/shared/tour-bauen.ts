// Aus einer Liste Praxen eine fahrbare Tour machen.
//
// Hier steckt die eigentliche Entscheidung, wie gefahren wird:
//  • Ein Stopp ist eine Adresse, keine Praxis — im Ärztehaus hält man einmal.
//  • Die Stopps werden nach Himmelsrichtung vom Betrieb aus in Tagesblöcke
//    geschnitten, damit jeder Tag ein kompaktes Tortenstück wird.
//  • Innerhalb eines Tages bestimmen Nächster Nachbar, 2-opt und Or-opt die
//    Reihenfolge, gerechnet auf echten Fahrzeiten.
//  • Jeder Tag beginnt und endet am Betrieb.
//
// Kein Datenbankzugriff: rein rein, raus raus. Dadurch läuft derselbe Code im
// Server auf Railway und in einer Netlify-Funktion — und ist testbar, ohne
// irgendetwas hochzufahren.

import type { DienstKonfig } from './dienste';
import { haversineM, type Punkt } from './geo';
import { fahrzeitMatrix, routeAbfahren } from './osrm';
import { gruppiereStopps, optimiere, sweepTage, type Stopp } from './optimize';
import type { PraxisAusgang } from './typen';

export interface TourStopp extends Stopp {
  position: number;
  /** Strecke vom vorherigen Punkt hierher; beim ersten Stopp ab Betrieb. */
  strecke_m: number | null;
  fahrzeit_s: number | null;
}

export interface TourTag {
  tag: number;
  stopps: TourStopp[];
  /** Gesamtstrecke des Tages inklusive Rückweg zum Betrieb. */
  strecke_m: number;
  fahrzeit_s: number;
  /** Letzte Etappe: vom letzten Stopp zurück zum Betrieb. */
  rueckweg_m: number | null;
  rueckweg_s: number | null;
  /** Encoded Polyline für die Karte, falls OSRM eine geliefert hat. */
  geometrie?: string;
}

export interface TourBauParams {
  kategorien: string[];
  radiusKm: number;
  stoppsProTag: number;
  /** Deckel für Testläufe; 0 oder nicht gesetzt = alle. */
  maxStopps?: number;
  /** Erledigte Praxen auslassen — für die zweite Runde. */
  nurOffene?: boolean;
}

export interface TourErgebnis {
  tage: TourTag[];
  strecke_m: number;
  fahrzeit_s: number;
  /** "osrm", "luftlinie" oder beides, wenn Tage unterschiedlich gerechnet wurden. */
  matrix_quelle: string;
  hinweise: string[];
}

/**
 * Baut die Tagestouren. `praxen` ist bereits gefiltert (Kategorie, Radius,
 * Status) — diese Funktion entscheidet nur noch über die Fahrt.
 */
export async function tourBauenAus(
  praxen: PraxisAusgang[],
  start: Punkt,
  params: TourBauParams,
  dienste: DienstKonfig,
): Promise<TourErgebnis> {
  if (praxen.length === 0) {
    throw new Error(
      'Keine Praxen für diese Auswahl. Erst importieren oder Radius und Kategorien weiter fassen.',
    );
  }

  const hinweise: string[] = [];
  let stopps = gruppiereStopps(praxen);

  // Beim Deckeln die nächstgelegenen behalten: eine Tour, die am Betrieb
  // anfängt, soll nicht als Erstes zwölf Kilometer rausfahren.
  if (params.maxStopps && params.maxStopps > 0 && stopps.length > params.maxStopps) {
    stopps = [...stopps]
      .sort((a, b) => haversineM(start, a) - haversineM(start, b))
      .slice(0, params.maxStopps);
  }

  const tage = sweepTage(start, stopps, params.stoppsProTag);
  const ergebnisTage: TourTag[] = [];
  const matrixQuellen = new Set<string>();
  let gesamtStrecke = 0;
  let gesamtZeit = 0;

  for (let t = 0; t < tage.length; t++) {
    const tagStopps = tage[t];
    const punkte: Punkt[] = [start, ...tagStopps];
    const matrix = await fahrzeitMatrix(punkte, dienste);
    matrixQuellen.add(matrix.quelle);
    if (matrix.hinweis) hinweise.push(`Tag ${t + 1}: ${matrix.hinweis}`);

    const mitte = tagStopps.map((_, i) => i + 1);
    // Start und Ziel sind derselbe Index 0 — daraus wird der geschlossene Ring.
    const { folge } = optimiere(matrix.dauern, 0, 0, mitte);

    const geordnet = folge.map(i => punkte[i]);
    const gefahren = await routeAbfahren(geordnet, dienste);

    const stoppFolge = folge.slice(1, -1); // ohne Start und Rückkehr
    const stoppListe: TourStopp[] = stoppFolge.map((idx, pos) => ({
      ...tagStopps[idx - 1],
      position: pos + 1,
      // abschnitte[pos] ist die Fahrt vom vorherigen Punkt hierher;
      // Abschnitt 0 ist Betrieb → erster Stopp.
      strecke_m: gefahren.abschnitte[pos]?.strecke_m ?? null,
      fahrzeit_s: gefahren.abschnitte[pos]?.fahrzeit_s ?? null,
    }));

    const rueckweg = gefahren.abschnitte[gefahren.abschnitte.length - 1];
    gesamtStrecke += gefahren.gesamt_m;
    gesamtZeit += gefahren.gesamt_s;
    ergebnisTage.push({
      tag: t + 1,
      stopps: stoppListe,
      strecke_m: gefahren.gesamt_m,
      fahrzeit_s: gefahren.gesamt_s,
      rueckweg_m: rueckweg?.strecke_m ?? null,
      rueckweg_s: rueckweg?.fahrzeit_s ?? null,
      geometrie: gefahren.geometrie,
    });
  }

  return {
    tage: ergebnisTage,
    strecke_m: gesamtStrecke,
    fahrzeit_s: gesamtZeit,
    matrix_quelle: [...matrixQuellen].join('+') || 'luftlinie',
    hinweise,
  };
}

/**
 * Mitten in der Tour neu ordnen: von der aktuellen Position aus die noch
 * offenen Stopps, zum Schluss zurück zum Betrieb.
 */
export async function weiterAbPosition(
  offeneStopps: Stopp[],
  position: Punkt,
  heim: Punkt,
  dienste: DienstKonfig,
): Promise<{
  stopps: TourStopp[];
  strecke_m: number;
  fahrzeit_s: number;
  geometrie?: string;
  quelle: string;
}> {
  if (offeneStopps.length === 0) {
    return { stopps: [], strecke_m: 0, fahrzeit_s: 0, quelle: 'keine' };
  }
  // 0 = aktueller Standort, dann die Stopps, zuletzt der Betrieb als Ziel.
  const punkte: Punkt[] = [position, ...offeneStopps, heim];
  const zielIdx = punkte.length - 1;
  const matrix = await fahrzeitMatrix(punkte, dienste);
  const mitte = offeneStopps.map((_, i) => i + 1);
  const { folge } = optimiere(matrix.dauern, 0, zielIdx, mitte);

  const geordnet = folge.map(i => punkte[i]);
  const gefahren = await routeAbfahren(geordnet, dienste);

  const stopps: TourStopp[] = folge.slice(1, -1).map((idx, pos) => ({
    ...offeneStopps[idx - 1],
    position: pos + 1,
    strecke_m: gefahren.abschnitte[pos]?.strecke_m ?? null,
    fahrzeit_s: gefahren.abschnitte[pos]?.fahrzeit_s ?? null,
  }));

  return {
    stopps,
    strecke_m: gefahren.gesamt_m,
    fahrzeit_s: gefahren.gesamt_s,
    geometrie: gefahren.geometrie,
    quelle: matrix.quelle,
  };
}
