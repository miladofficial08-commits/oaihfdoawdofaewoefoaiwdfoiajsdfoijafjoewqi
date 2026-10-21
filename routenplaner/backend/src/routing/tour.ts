// Tour bauen, speichern, auslesen und unterwegs neu ordnen.
//
// Entscheidungen, die hier festgelegt sind:
//  • Ein Stopp ist eine Adresse, keine Praxis (siehe gruppiereStopps).
//  • Jeder Tag ist ein geschlossener Ring: morgens vom Betrieb los, abends
//    zurück zum Betrieb.
//  • Abgearbeitete Stopps fliegen nicht aus der gespeicherten Tour, sie
//    werden nur als erledigt angezeigt. Wer die Tour neu baut, verliert
//    nichts: der Besuchsstand hängt an der Praxis, nicht an der Tour.

import { getDb, leseEinstellung, setzeEinstellung } from '../db';
import { config } from '../config';
import { haversineM, type Punkt } from '../geo';
import { praxenLesen } from '../praxen-repo';
import { geokodieren } from '../sources/nominatim';
import type { PraxisAusgang } from '../typen';
import { fahrzeitMatrix, routeAbfahren } from './osrm';
import { gruppiereStopps, optimiere, sweepTage, type Stopp } from './optimize';

export interface Betriebssitz extends Punkt {
  adresse: string;
  /** "geokodiert" = über Nominatim bestimmt, "fallback" = Mittelpunkt Eller. */
  quelle: 'geokodiert' | 'manuell' | 'fallback';
}

export function betriebssitzLesen(): Betriebssitz {
  const adresse = leseEinstellung('start_adresse');
  const lat = leseEinstellung('start_lat');
  const lon = leseEinstellung('start_lon');
  const quelle = leseEinstellung('start_quelle');
  if (adresse && lat && lon) {
    return {
      adresse,
      lat: Number(lat),
      lon: Number(lon),
      quelle: (quelle as Betriebssitz['quelle']) || 'manuell',
    };
  }
  return {
    adresse: config.startAdresse,
    lat: config.startLatFallback,
    lon: config.startLonFallback,
    quelle: 'fallback',
  };
}

export function betriebssitzSetzenManuell(adresse: string, lat: number, lon: number): Betriebssitz {
  setzeEinstellung('start_adresse', adresse);
  setzeEinstellung('start_lat', String(lat));
  setzeEinstellung('start_lon', String(lon));
  setzeEinstellung('start_quelle', 'manuell');
  return { adresse, lat, lon, quelle: 'manuell' };
}

/**
 * Adresse geokodieren und als Betriebssitz merken. Schlägt das Geocoding
 * fehl, bleibt der bisherige Sitz stehen und der Fehler wird gemeldet —
 * stillschweigend auf eine Fallback-Koordinate zurückfallen würde eine
 * komplette Tour an der falschen Stelle aufhängen.
 */
export async function betriebssitzSetzen(adresse: string): Promise<Betriebssitz> {
  const treffer = await geokodieren(adresse);
  if (!treffer) throw new Error(`Adresse nicht gefunden: ${adresse}`);
  setzeEinstellung('start_adresse', treffer.anzeigename);
  setzeEinstellung('start_lat', String(treffer.lat));
  setzeEinstellung('start_lon', String(treffer.lon));
  setzeEinstellung('start_quelle', 'geokodiert');
  return {
    adresse: treffer.anzeigename,
    lat: treffer.lat,
    lon: treffer.lon,
    quelle: 'geokodiert',
  };
}

export interface TourBauParams {
  kategorien: string[];
  radiusKm: number;
  stoppsProTag: number;
  /** Deckel für Testläufe; 0 = alle. */
  maxStopps?: number;
  /** Erledigte Praxen auslassen — für die zweite Runde. */
  nurOffene?: boolean;
}

export interface TourTag {
  tag: number;
  stopps: Array<
    Stopp & {
      position: number;
      strecke_m: number | null;
      fahrzeit_s: number | null;
    }
  >;
  /** Gesamtstrecke des Tages inklusive Rückweg zum Betrieb. */
  strecke_m: number;
  fahrzeit_s: number;
  /** Letzte Etappe: vom letzten Stopp zurück zum Betrieb. */
  rueckweg_m: number | null;
  rueckweg_s: number | null;
  geometrie?: string;
}

export interface TourAusgang {
  id: number;
  erstellt_am: string;
  start: Betriebssitz;
  params: TourBauParams;
  tage: TourTag[];
  strecke_m: number;
  fahrzeit_s: number;
  matrix_quelle: string;
  hinweise: string[];
}

export async function tourBauen(params: TourBauParams): Promise<TourAusgang> {
  const start = betriebssitzLesen();
  const hinweise: string[] = [];
  if (start.quelle === 'fallback') {
    hinweise.push(
      `Startpunkt ist noch nicht geokodiert — gerechnet wird mit dem Mittelpunkt von Düsseldorf-Eller. Adresse unter "Startpunkt" bestätigen.`,
    );
  }

  const praxen = praxenLesen({
    kategorien: params.kategorien,
    maxEntfernungM: Math.round(params.radiusKm * 1000),
    status: params.nurOffene ? ['offen', 'nochmal'] : undefined,
  });
  if (praxen.length === 0) {
    throw new Error(
      'Keine Praxen für diese Auswahl. Erst importieren oder Radius/Kategorien weiter fassen.',
    );
  }

  let stopps = gruppiereStopps(praxen);
  // Die nächstgelegenen zuerst wegnehmen, wenn gedeckelt wird: eine Tour, die
  // am Betrieb anfängt, soll nicht als Erstes 12 km rausfahren.
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
    const matrix = await fahrzeitMatrix(punkte);
    matrixQuellen.add(matrix.quelle);
    if (matrix.hinweis) hinweise.push(`Tag ${t + 1}: ${matrix.hinweis}`);

    const mitte = tagStopps.map((_, i) => i + 1);
    // Start und Ziel sind derselbe Index 0 — daraus wird der geschlossene Ring.
    const { folge } = optimiere(matrix.dauern, 0, 0, mitte);

    // folge enthält [0, …Stopps…, 0]. Für die Fahrt zählt genau das.
    const geordnet = folge.map(i => punkte[i]);
    const gefahren = await routeAbfahren(geordnet);

    const stoppFolge = folge.slice(1, -1); // ohne Start und Rückkehr
    const stoppListe = stoppFolge.map((idx, pos) => ({
      ...tagStopps[idx - 1],
      position: pos + 1,
      // abschnitte[pos] ist die Fahrt vom vorherigen Punkt hierher;
      // Abschnitt 0 ist Betrieb → erster Stopp.
      strecke_m: gefahren.abschnitte[pos]?.strecke_m ?? null,
      fahrzeit_s: gefahren.abschnitte[pos]?.fahrzeit_s ?? null,
    }));

    // Die letzte Etappe führt vom letzten Stopp zurück zum Betrieb. Sie
    // gehört zu keinem Stopp, zählt aber zur Tagesstrecke — ohne sie wäre die
    // angezeigte Strecke kleiner als die tatsächlich gefahrene.
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

  const matrixQuelle = [...matrixQuellen].join('+') || 'luftlinie';
  const id = tourSpeichern(start, params, ergebnisTage, gesamtStrecke, gesamtZeit, matrixQuelle);

  return {
    id,
    erstellt_am: new Date().toISOString(),
    start,
    params,
    tage: ergebnisTage,
    strecke_m: gesamtStrecke,
    fahrzeit_s: gesamtZeit,
    matrix_quelle: matrixQuelle,
    hinweise,
  };
}

function tourSpeichern(
  start: Betriebssitz,
  params: TourBauParams,
  tage: TourTag[],
  strecke: number,
  zeit: number,
  matrixQuelle: string,
): number {
  const db = getDb();
  const stoppZahl = tage.reduce((s, t) => s + t.stopps.length, 0);
  const lauf = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO touren (erstellt_am, start_adresse, start_lat, start_lon, params,
                             tage, stopps, strecke_m, fahrzeit_s, matrix_quelle)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        new Date().toISOString(),
        start.adresse,
        start.lat,
        start.lon,
        JSON.stringify(params),
        tage.length,
        stoppZahl,
        Math.round(strecke),
        Math.round(zeit),
        matrixQuelle,
      );
    const tourId = Number(info.lastInsertRowid);
    const einfuegen = db.prepare(
      `INSERT INTO tour_stopps (tour_id, tag, position, adress_key, lat, lon, strecke_m, fahrzeit_s)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const tagEinfuegen = db.prepare(
      `INSERT INTO tour_tage (tour_id, tag, strecke_m, fahrzeit_s, rueckweg_m, rueckweg_s, geometrie)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const tag of tage) {
      for (const s of tag.stopps) {
        einfuegen.run(
          tourId,
          tag.tag,
          s.position,
          s.adress_key,
          s.lat,
          s.lon,
          s.strecke_m,
          s.fahrzeit_s,
        );
      }
      tagEinfuegen.run(
        tourId,
        tag.tag,
        Math.round(tag.strecke_m),
        Math.round(tag.fahrzeit_s),
        tag.rueckweg_m,
        tag.rueckweg_s,
        tag.geometrie ?? null,
      );
    }
    // Nur die jeweils aktuelle Tour wird gebraucht; ältere halten die
    // Datenbank klein und das Frontend eindeutig.
    db.prepare(`DELETE FROM tour_stopps WHERE tour_id <> ?`).run(tourId);
    db.prepare(`DELETE FROM tour_tage WHERE tour_id <> ?`).run(tourId);
    db.prepare(`DELETE FROM touren WHERE id <> ?`).run(tourId);
    return tourId;
  });
  return lauf();
}

interface StoppZeile {
  tag: number;
  position: number;
  adress_key: string;
  lat: number;
  lon: number;
  strecke_m: number | null;
  fahrzeit_s: number | null;
}

/**
 * Die gespeicherte Tour mit tagesaktuellem Besuchsstand. Die Praxen werden
 * frisch dazugeladen, damit ein Häkchen vom anderen Handy sofort sichtbar ist.
 */
export function tourLesen(): TourAusgang | null {
  const db = getDb();
  const tour = db
    .prepare(`SELECT * FROM touren ORDER BY id DESC LIMIT 1`)
    .get() as
    | {
        id: number;
        erstellt_am: string;
        start_adresse: string;
        start_lat: number;
        start_lon: number;
        params: string;
        strecke_m: number;
        fahrzeit_s: number;
        matrix_quelle: string;
      }
    | undefined;
  if (!tour) return null;

  const zeilen = db
    .prepare(
      `SELECT tag, position, adress_key, lat, lon, strecke_m, fahrzeit_s
         FROM tour_stopps WHERE tour_id = ? ORDER BY tag, position`,
    )
    .all(tour.id) as StoppZeile[];

  const tagWerte = new Map(
    (
      db
        .prepare(
          `SELECT tag, strecke_m, fahrzeit_s, rueckweg_m, rueckweg_s, geometrie
             FROM tour_tage WHERE tour_id = ?`,
        )
        .all(tour.id) as Array<{
        tag: number;
        strecke_m: number;
        fahrzeit_s: number;
        rueckweg_m: number | null;
        rueckweg_s: number | null;
        geometrie: string | null;
      }>
    ).map(r => [r.tag, r]),
  );

  const keys = [...new Set(zeilen.map(z => z.adress_key))];
  const praxenNachKey = new Map<string, PraxisAusgang[]>();
  if (keys.length > 0) {
    // In Blöcken, damit SQLites Parametergrenze (999) nicht gerissen wird.
    for (let i = 0; i < keys.length; i += 500) {
      const block = keys.slice(i, i + 500);
      const treffer = praxenLesenNachKeys(block);
      for (const p of treffer) {
        const liste = praxenNachKey.get(p.adress_key);
        if (liste) liste.push(p);
        else praxenNachKey.set(p.adress_key, [p]);
      }
    }
  }

  const tageMap = new Map<number, TourTag>();
  for (const z of zeilen) {
    const praxen = praxenNachKey.get(z.adress_key) ?? [];
    // Stopp, dessen Praxen inzwischen weg sind (Import hat sie entfernt):
    // überspringen statt leeren Halt anzeigen.
    if (praxen.length === 0) continue;
    const gruppe = gruppiereStopps(praxen)[0];
    let tag = tageMap.get(z.tag);
    if (!tag) {
      const werte = tagWerte.get(z.tag);
      tag = {
        tag: z.tag,
        stopps: [],
        strecke_m: werte?.strecke_m ?? 0,
        fahrzeit_s: werte?.fahrzeit_s ?? 0,
        rueckweg_m: werte?.rueckweg_m ?? null,
        rueckweg_s: werte?.rueckweg_s ?? null,
        geometrie: werte?.geometrie ?? undefined,
      };
      tageMap.set(z.tag, tag);
    }
    tag.stopps.push({
      ...gruppe,
      lat: z.lat,
      lon: z.lon,
      position: z.position,
      strecke_m: z.strecke_m,
      fahrzeit_s: z.fahrzeit_s,
    });
  }

  // Touren aus einer älteren Fassung haben keine Tageszeile. Dann bleibt nur
  // die Summe der Etappen – ohne Rückweg, aber besser als null.
  for (const tag of tageMap.values()) {
    if (tag.strecke_m === 0 && tag.stopps.length > 0) {
      tag.strecke_m = tag.stopps.reduce((n, s) => n + (s.strecke_m ?? 0), 0);
      tag.fahrzeit_s = tag.stopps.reduce((n, s) => n + (s.fahrzeit_s ?? 0), 0);
    }
  }

  const tage = [...tageMap.values()].sort((a, b) => a.tag - b.tag);
  return {
    id: tour.id,
    erstellt_am: tour.erstellt_am,
    start: {
      adresse: tour.start_adresse,
      lat: tour.start_lat,
      lon: tour.start_lon,
      quelle: 'manuell',
    },
    params: JSON.parse(tour.params) as TourBauParams,
    tage,
    strecke_m: tour.strecke_m,
    fahrzeit_s: tour.fahrzeit_s,
    matrix_quelle: tour.matrix_quelle,
    hinweise: [],
  };
}

function praxenLesenNachKeys(keys: string[]): PraxisAusgang[] {
  if (keys.length === 0) return [];
  return getDb()
    .prepare(
      `SELECT p.id, p.name, p.kategorie, p.fachrichtung, p.strasse, p.hausnummer, p.plz,
              p.ort, p.stadtteil, p.lat, p.lon, p.telefon, p.website, p.email,
              p.oeffnungszeiten, p.barrierefrei, p.quelle, p.source_url, p.adress_key,
              p.entfernung_m,
              COALESCE(b.status, 'offen') AS status, b.notiz, b.ansprechpartner,
              b.potenzial, COALESCE(b.material_da, 0) AS material_da, b.wiedervorlage,
              b.bearbeiter, b.besucht_am
         FROM praxen p LEFT JOIN besuche b ON b.praxis_id = p.id
        WHERE p.aktiv = 1 AND p.adress_key IN (${keys.map(() => '?').join(',')})`,
    )
    .all(...keys) as PraxisAusgang[];
}

export interface WeiterErgebnis {
  tag: number;
  /** Neue Reihenfolge der noch offenen Stopps, ab aktuellem Standort. */
  stopps: TourTag['stopps'];
  strecke_m: number;
  fahrzeit_s: number;
  geometrie?: string;
  uebersprungen: number;
  quelle: string;
}

/**
 * Mitten in der Tour neu sortieren: von der aktuellen GPS-Position aus die
 * restlichen offenen Stopps des Tages, zum Schluss zurück zum Betrieb.
 *
 * Die neue Reihenfolge wird gespeichert — sonst sieht der Kollege auf dem
 * zweiten Handy noch die alte und man trifft sich nirgends.
 */
export async function weiterAbHier(
  tag: number,
  position: Punkt,
): Promise<WeiterErgebnis> {
  const tour = tourLesen();
  if (!tour) throw new Error('Es ist noch keine Tour gebaut.');
  const tagDaten = tour.tage.find(t => t.tag === tag);
  if (!tagDaten) throw new Error(`Tag ${tag} gibt es in dieser Tour nicht.`);

  // Offen ist ein Stopp, solange dort mindestens eine Praxis noch aussteht.
  const offen = tagDaten.stopps.filter(s =>
    s.praxen.some(p => p.status === 'offen' || p.status === 'nochmal'),
  );
  const uebersprungen = tagDaten.stopps.length - offen.length;
  if (offen.length === 0) {
    return {
      tag,
      stopps: [],
      strecke_m: 0,
      fahrzeit_s: 0,
      uebersprungen,
      quelle: 'keine',
    };
  }

  const heim = betriebssitzLesen();
  // Reihenfolge der Matrixpunkte: 0 = aktueller Standort, dann die Stopps,
  // zuletzt der Betrieb als festes Ziel.
  const punkte: Punkt[] = [position, ...offen, heim];
  const zielIdx = punkte.length - 1;
  const matrix = await fahrzeitMatrix(punkte);
  const mitte = offen.map((_, i) => i + 1);
  const { folge } = optimiere(matrix.dauern, 0, zielIdx, mitte);

  const geordnet = folge.map(i => punkte[i]);
  const gefahren = await routeAbfahren(geordnet);

  const stoppFolge = folge.slice(1, -1);
  const neueStopps = stoppFolge.map((idx, pos) => ({
    ...offen[idx - 1],
    position: pos + 1,
    strecke_m: gefahren.abschnitte[pos]?.strecke_m ?? null,
    fahrzeit_s: gefahren.abschnitte[pos]?.fahrzeit_s ?? null,
  }));

  speichereTagNeu(tour.id, tag, tagDaten.stopps, neueStopps, {
    strecke_m: gefahren.gesamt_m,
    fahrzeit_s: gefahren.gesamt_s,
    rueckweg: gefahren.abschnitte[gefahren.abschnitte.length - 1],
    geometrie: gefahren.geometrie,
  });

  return {
    tag,
    stopps: neueStopps,
    strecke_m: gefahren.gesamt_m,
    fahrzeit_s: gefahren.gesamt_s,
    geometrie: gefahren.geometrie,
    uebersprungen,
    quelle: matrix.quelle,
  };
}

/**
 * Tag neu schreiben: erledigte Stopps vorne (als Historie), danach die neue
 * Reihenfolge der offenen. Die erledigten bleiben drin, damit die Tagesliste
 * nachher vollständig ist und man sieht, was man geschafft hat.
 */
function speichereTagNeu(
  tourId: number,
  tag: number,
  alleStopps: TourTag['stopps'],
  neueOffene: TourTag['stopps'],
  werte: {
    strecke_m: number;
    fahrzeit_s: number;
    rueckweg?: { strecke_m: number; fahrzeit_s: number };
    geometrie?: string;
  },
): void {
  const db = getDb();
  const offenKeys = new Set(neueOffene.map(s => s.adress_key));
  const erledigt = alleStopps.filter(s => !offenKeys.has(s.adress_key));
  const lauf = db.transaction(() => {
    db.prepare(`DELETE FROM tour_stopps WHERE tour_id = ? AND tag = ?`).run(tourId, tag);
    const einfuegen = db.prepare(
      `INSERT INTO tour_stopps (tour_id, tag, position, adress_key, lat, lon, strecke_m, fahrzeit_s)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let pos = 1;
    for (const s of erledigt) {
      einfuegen.run(tourId, tag, pos++, s.adress_key, s.lat, s.lon, s.strecke_m, s.fahrzeit_s);
    }
    for (const s of neueOffene) {
      einfuegen.run(tourId, tag, pos++, s.adress_key, s.lat, s.lon, s.strecke_m, s.fahrzeit_s);
    }
    // Die Tageswerte beziehen sich jetzt auf die Reststrecke ab dem aktuellen
    // Standort – was auch stimmt: der Vormittag ist gefahren, die Anzeige soll
    // sagen, was noch kommt.
    db.prepare(
      `INSERT INTO tour_tage (tour_id, tag, strecke_m, fahrzeit_s, rueckweg_m, rueckweg_s, geometrie)
            VALUES (@tour, @tag, @strecke, @zeit, @rweg, @rzeit, @geo)
       ON CONFLICT(tour_id, tag) DO UPDATE SET
            strecke_m = excluded.strecke_m,
            fahrzeit_s = excluded.fahrzeit_s,
            rueckweg_m = excluded.rueckweg_m,
            rueckweg_s = excluded.rueckweg_s,
            geometrie = excluded.geometrie`,
    ).run({
      tour: tourId,
      tag,
      strecke: Math.round(werte.strecke_m),
      zeit: Math.round(werte.fahrzeit_s),
      rweg: werte.rueckweg?.strecke_m ?? null,
      rzeit: werte.rueckweg?.fahrzeit_s ?? null,
      geo: werte.geometrie ?? null,
    });
  });
  lauf();
}
