// Echte Fahrzeiten über OSRM (Open Source Routing Machine).
//
// Standard ist der öffentliche Demo-Server von OSRM. Der ist gratis, aber
// ausdrücklich ohne Zusage: er drosselt, ist manchmal weg und begrenzt die
// Matrixgröße (üblicherweise 100 Koordinaten). Deshalb gilt in dieser Datei
// durchgehend: wenn OSRM nicht liefert, wird mit Luftlinie weitergerechnet.
// Die Tour ist dann leicht schlechter sortiert, aber sie existiert — und die
// Oberfläche sagt an, welche Quelle benutzt wurde.
//
// Für Dauerbetrieb lohnt ein eigener OSRM-Container (OSRM_BASE umstellen);
// dann fallen Drosselung und Größengrenze weg.

import type { DienstKonfig } from './dienste';
import { haversineM, type Punkt } from './geo';

/** Maximale Koordinatenzahl pro /table-Anfrage beim Demo-Server. */
const MATRIX_GRENZE = 95;

/**
 * Annahme für den Luftlinien-Rückfall: 24 km/h Durchschnitt im Stadtverkehr
 * plus 35 % Umwegfaktor gegenüber der Luftlinie. Das trifft Düsseldorfer
 * Stadtteilverkehr brauchbar; es geht hier nur um die Reihenfolge, nicht um
 * eine Ankunftsprognose.
 */
const STADT_MPS = 24_000 / 3600;
const UMWEG_FAKTOR = 1.35;

export interface Matrix {
  /** dauern[i][j] = Sekunden von i nach j. */
  dauern: number[][];
  /** strecken[i][j] = Meter von i nach j. */
  strecken: number[][];
  quelle: 'osrm' | 'luftlinie';
  hinweis?: string;
}

function luftlinienMatrix(punkte: Punkt[], hinweis?: string): Matrix {
  const n = punkte.length;
  const dauern: number[][] = [];
  const strecken: number[][] = [];
  for (let i = 0; i < n; i++) {
    dauern.push(new Array(n).fill(0));
    strecken.push(new Array(n).fill(0));
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const m = haversineM(punkte[i], punkte[j]) * UMWEG_FAKTOR;
      strecken[i][j] = m;
      dauern[i][j] = m / STADT_MPS;
    }
  }
  return { dauern, strecken, quelle: 'luftlinie', hinweis };
}

function koordinatenListe(punkte: Punkt[]): string {
  // OSRM erwartet lon,lat — nicht lat,lon. Häufigste Fehlerquelle überhaupt.
  return punkte.map(p => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
}

export async function fahrzeitMatrix(
  punkte: Punkt[],
  dienste: DienstKonfig,
): Promise<Matrix> {
  if (punkte.length < 2) return luftlinienMatrix(punkte);
  if (punkte.length > MATRIX_GRENZE) {
    return luftlinienMatrix(
      punkte,
      `${punkte.length} Punkte überschreiten die Matrixgrenze des OSRM-Servers (${MATRIX_GRENZE}) – mit Luftlinie gerechnet.`,
    );
  }
  const url =
    `${dienste.osrmBase}/table/v1/driving/${koordinatenListe(punkte)}` +
    `?annotations=duration,distance`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': dienste.userAgent },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      return luftlinienMatrix(punkte, `OSRM antwortete ${res.status} – mit Luftlinie gerechnet.`);
    }
    const daten = (await res.json()) as {
      code?: string;
      durations?: Array<Array<number | null>>;
      distances?: Array<Array<number | null>>;
    };
    if (daten.code !== 'Ok' || !daten.durations) {
      return luftlinienMatrix(punkte, `OSRM: ${daten.code ?? 'unklare Antwort'} – mit Luftlinie gerechnet.`);
    }
    const ersatz = luftlinienMatrix(punkte);
    const n = punkte.length;
    const dauern: number[][] = [];
    const strecken: number[][] = [];
    for (let i = 0; i < n; i++) {
      dauern.push(new Array(n).fill(0));
      strecken.push(new Array(n).fill(0));
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        // Einzelne null-Werte (nicht erreichbarer Punkt) mit Luftlinie füllen,
        // sonst sortiert der Optimierer sie fälschlich an den Anfang.
        const d = daten.durations[i]?.[j];
        const s = daten.distances?.[i]?.[j];
        dauern[i][j] = typeof d === 'number' ? d : ersatz.dauern[i][j];
        strecken[i][j] = typeof s === 'number' ? s : ersatz.strecken[i][j];
      }
    }
    return { dauern, strecken, quelle: 'osrm' };
  } catch (err) {
    return luftlinienMatrix(
      punkte,
      `OSRM nicht erreichbar (${err instanceof Error ? err.message : String(err)}) – mit Luftlinie gerechnet.`,
    );
  }
}

export interface Streckenabschnitt {
  strecke_m: number;
  fahrzeit_s: number;
}

export interface GefahreneRoute {
  gesamt_m: number;
  gesamt_s: number;
  abschnitte: Streckenabschnitt[];
  /** Encoded Polyline (Präzision 5) für die Kartendarstellung, falls vorhanden. */
  geometrie?: string;
  quelle: 'osrm' | 'luftlinie';
}

/**
 * Fährt die Punkte in der übergebenen Reihenfolge ab und liefert Strecke,
 * Zeit und Linienverlauf. Für die Anzeige, nicht für die Optimierung.
 */
export async function routeAbfahren(
  punkte: Punkt[],
  dienste: DienstKonfig,
): Promise<GefahreneRoute> {
  const ersatz = (): GefahreneRoute => {
    const abschnitte: Streckenabschnitt[] = [];
    let gesamt_m = 0;
    let gesamt_s = 0;
    for (let i = 1; i < punkte.length; i++) {
      const m = haversineM(punkte[i - 1], punkte[i]) * UMWEG_FAKTOR;
      const s = m / STADT_MPS;
      abschnitte.push({ strecke_m: Math.round(m), fahrzeit_s: Math.round(s) });
      gesamt_m += m;
      gesamt_s += s;
    }
    return {
      gesamt_m: Math.round(gesamt_m),
      gesamt_s: Math.round(gesamt_s),
      abschnitte,
      quelle: 'luftlinie',
    };
  };

  if (punkte.length < 2) {
    return { gesamt_m: 0, gesamt_s: 0, abschnitte: [], quelle: 'luftlinie' };
  }
  // Der Demo-Server nimmt lange Koordinatenlisten per GET nur begrenzt an.
  if (punkte.length > MATRIX_GRENZE) return ersatz();

  const url =
    `${dienste.osrmBase}/route/v1/driving/${koordinatenListe(punkte)}` +
    `?overview=simplified&geometries=polyline&annotations=false&steps=false`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': dienste.userAgent },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return ersatz();
    const daten = (await res.json()) as {
      code?: string;
      routes?: Array<{
        distance: number;
        duration: number;
        geometry?: string;
        legs?: Array<{ distance: number; duration: number }>;
      }>;
    };
    const route = daten.routes?.[0];
    if (daten.code !== 'Ok' || !route) return ersatz();
    return {
      gesamt_m: Math.round(route.distance),
      gesamt_s: Math.round(route.duration),
      abschnitte: (route.legs ?? []).map(l => ({
        strecke_m: Math.round(l.distance),
        fahrzeit_s: Math.round(l.duration),
      })),
      geometrie: route.geometry,
      quelle: 'osrm',
    };
  } catch {
    return ersatz();
  }
}
