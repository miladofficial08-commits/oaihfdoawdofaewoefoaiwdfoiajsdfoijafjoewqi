// Reihenfolge der Stopps bestimmen.
//
// Die Aufgabe ist ein Rundreiseproblem mit festem Start und festem Ziel
// (beides der Betriebssitz). Exakt lösen muss man das nicht: bei 15–25 Stopps
// pro Tag liegt "Nächster Nachbar + 2-opt + Or-opt" erfahrungsgemäß wenige
// Prozent über dem Optimum, rechnet in Millisekunden und braucht keinen
// externen Dienst.
//
// Alle Funktionen hier sind rein (Matrix rein, Reihenfolge raus) — damit sind
// sie ohne Netz und ohne Datenbank testbar.

import { peilung, type Punkt } from './geo';
import type { PraxisAusgang } from './typen';

export interface Stopp {
  adress_key: string;
  lat: number;
  lon: number;
  adresse: string;
  stadtteil: string | null;
  praxen: PraxisAusgang[];
}

/**
 * Praxen zu Stopps zusammenfassen: eine Adresse = ein Halt. Im Ärztehaus
 * steigt man einmal aus und klingelt oben an vier Türen.
 */
export function gruppiereStopps(praxen: PraxisAusgang[]): Stopp[] {
  const nachKey = new Map<string, PraxisAusgang[]>();
  for (const p of praxen) {
    const liste = nachKey.get(p.adress_key);
    if (liste) liste.push(p);
    else nachKey.set(p.adress_key, [p]);
  }

  const stopps: Stopp[] = [];
  for (const [key, liste] of nachKey) {
    // Mittelwert der Koordinaten: bei zwei OSM-Knoten im selben Haus liegen
    // die ein paar Meter auseinander, der Mittelpunkt trifft die Tür besser.
    const lat = liste.reduce((s, p) => s + p.lat, 0) / liste.length;
    const lon = liste.reduce((s, p) => s + p.lon, 0) / liste.length;
    const mitAdresse = liste.find(p => p.strasse);
    const adresse = mitAdresse
      ? [
          [mitAdresse.strasse, mitAdresse.hausnummer].filter(Boolean).join(' '),
          [mitAdresse.plz, mitAdresse.ort].filter(Boolean).join(' '),
        ]
          .filter(Boolean)
          .join(', ')
      : 'Adresse nicht hinterlegt';
    stopps.push({
      adress_key: key,
      lat,
      lon,
      adresse,
      stadtteil: liste.find(p => p.stadtteil)?.stadtteil ?? null,
      // Innerhalb eines Hauses zuerst die wahrscheinlichsten Auftraggeber.
      praxen: [...liste].sort(
        (a, b) => kategorieRang(a.kategorie) - kategorieRang(b.kategorie),
      ),
    });
  }
  return stopps;
}

function kategorieRang(kategorie: string): number {
  const rang: Record<string, number> = {
    prio_facharzt: 0,
    hausarzt: 1,
    arzt_unklar: 2,
    aerztehaus: 3,
    physio: 4,
    pflege: 5,
    facharzt: 6,
  };
  return rang[kategorie] ?? 9;
}

/**
 * Stopps in Tagestouren schneiden.
 *
 * Verfahren: alle Stopps nach Kompassrichtung vom Betriebssitz aus sortieren
 * und in Blöcke gleicher Größe teilen. Jeder Tag wird dadurch ein
 * Tortenstück — kompakt und ohne Kreuz-und-quer. Der Schnitt beginnt an der
 * größten Richtungslücke, damit keine dicht beieinander liegende Gruppe auf
 * zwei Tage zerrissen wird.
 */
export function sweepTage(start: Punkt, stopps: Stopp[], proTag: number): Stopp[][] {
  if (stopps.length === 0) return [];
  const proTagSicher = Math.max(1, Math.floor(proTag));
  if (stopps.length <= proTagSicher) return [stopps];

  const mitWinkel = stopps
    .map(s => ({ s, winkel: peilung(start, s) }))
    .sort((a, b) => a.winkel - b.winkel);

  // Größte Lücke im Richtungskranz finden (inklusive Übergang 360° → 0°).
  let luecke = -1;
  let beginn = 0;
  for (let i = 0; i < mitWinkel.length; i++) {
    const naechster = mitWinkel[(i + 1) % mitWinkel.length].winkel;
    const spanne = (naechster - mitWinkel[i].winkel + 360) % 360;
    if (spanne > luecke) {
      luecke = spanne;
      beginn = (i + 1) % mitWinkel.length;
    }
  }

  const rotiert = [...mitWinkel.slice(beginn), ...mitWinkel.slice(0, beginn)].map(x => x.s);

  // Tage gleichmäßig füllen statt "20, 20, 2": ein Tag mit zwei Stopps wäre
  // eine verschenkte Fahrt.
  const anzahlTage = Math.ceil(rotiert.length / proTagSicher);
  const basis = Math.floor(rotiert.length / anzahlTage);
  const rest = rotiert.length % anzahlTage;

  const tage: Stopp[][] = [];
  let i = 0;
  for (let t = 0; t < anzahlTage; t++) {
    const groesse = basis + (t < rest ? 1 : 0);
    tage.push(rotiert.slice(i, i + groesse));
    i += groesse;
  }
  return tage;
}

/** Kosten einer Reihenfolge (Summe der Kanten entlang der Folge). */
export function folgeKosten(folge: number[], kosten: number[][]): number {
  let summe = 0;
  for (let i = 1; i < folge.length; i++) summe += kosten[folge[i - 1]][folge[i]];
  return summe;
}

/**
 * Nächster Nachbar: vom Start aus immer zum nächstgelegenen offenen Punkt.
 * Liefert eine brauchbare, aber meist nicht optimale Folge — die wird danach
 * von 2-opt und Or-opt aufgeräumt.
 */
function naechsterNachbar(kosten: number[][], start: number, mitte: number[]): number[] {
  const offen = new Set(mitte);
  const folge = [start];
  let aktuell = start;
  while (offen.size > 0) {
    let bester = -1;
    let bestKosten = Infinity;
    for (const kandidat of offen) {
      const k = kosten[aktuell][kandidat];
      if (k < bestKosten) {
        bestKosten = k;
        bester = kandidat;
      }
    }
    offen.delete(bester);
    folge.push(bester);
    aktuell = bester;
  }
  return folge;
}

/**
 * 2-opt: solange zwei Wege sich kreuzen, das Teilstück zwischen ihnen
 * umdrehen. Genau das beseitigt das "hin und wieder zurück", das bei
 * Nächster-Nachbar-Routen entsteht.
 *
 * Start (Index 0) und Ziel (letzter Index) bleiben stehen.
 */
function zweiOpt(folge: number[], kosten: number[][], maxRunden = 60): number[] {
  const f = [...folge];
  const n = f.length;
  if (n < 5) return f;
  for (let runde = 0; runde < maxRunden; runde++) {
    let verbessert = false;
    for (let i = 1; i < n - 2; i++) {
      for (let j = i + 1; j < n - 1; j++) {
        const a = f[i - 1], b = f[i], c = f[j], d = f[j + 1];
        const vorher = kosten[a][b] + kosten[c][d];
        const nachher = kosten[a][c] + kosten[b][d];
        // Kleine Schwelle gegen Endlosschleifen durch Rundungsrauschen.
        if (nachher < vorher - 0.5) {
          let l = i, r = j;
          while (l < r) {
            const tmp = f[l];
            f[l] = f[r];
            f[r] = tmp;
            l++;
            r--;
          }
          verbessert = true;
        }
      }
    }
    if (!verbessert) break;
  }
  return f;
}

/**
 * Or-opt: einzelne Stopps (und Paare) an eine bessere Stelle verschieben.
 * Fängt den Fall auf, den 2-opt nicht sieht — ein Stopp, der auf dem Rückweg
 * mitgenommen werden müsste statt am Anfang.
 */
function orOpt(folge: number[], kosten: number[][], maxRunden = 30): number[] {
  let f = [...folge];
  const n = f.length;
  if (n < 5) return f;
  for (let runde = 0; runde < maxRunden; runde++) {
    let verbessert = false;
    for (let laenge = 1; laenge <= 2; laenge++) {
      for (let i = 1; i + laenge <= n - 1; i++) {
        const block = f.slice(i, i + laenge);
        const ohne = [...f.slice(0, i), ...f.slice(i + laenge)];
        const aktuell = folgeKosten(f, kosten);
        let besteFolge: number[] | null = null;
        let besteKosten = aktuell;
        for (let j = 1; j < ohne.length; j++) {
          if (j === i) continue;
          const kandidat = [...ohne.slice(0, j), ...block, ...ohne.slice(j)];
          const k = folgeKosten(kandidat, kosten);
          if (k < besteKosten - 0.5) {
            besteKosten = k;
            besteFolge = kandidat;
          }
        }
        if (besteFolge) {
          f = besteFolge;
          verbessert = true;
        }
      }
    }
    if (!verbessert) break;
  }
  return f;
}

export interface OptimierErgebnis {
  /** Indizes in der Reihenfolge der Anfahrt, inklusive Start und Ziel. */
  folge: number[];
  kosten: number;
}

/**
 * Reihenfolge für einen Tag bestimmen.
 *
 * `start` und `ziel` sind Indizes in der Kostenmatrix. Sind sie gleich (die
 * Regel: morgens und abends derselbe Betriebssitz), wird daraus ein
 * geschlossener Ring; sonst ein Weg von A nach B — das ist der Fall
 * "weiter ab aktuellem Standort, abends nach Hause".
 */
export function optimiere(
  kosten: number[][],
  start: number,
  ziel: number,
  mitte: number[],
): OptimierErgebnis {
  if (mitte.length === 0) {
    const folge = start === ziel ? [start] : [start, ziel];
    return { folge, kosten: folgeKosten(folge, kosten) };
  }

  const nn = naechsterNachbar(kosten, start, mitte);
  // Ziel anhängen. Beim Ring ist das der Start selbst — d[x][x] ist 0, deshalb
  // rechnet derselbe Code beide Fälle.
  const mitZiel = [...nn, ziel];
  const nach2opt = zweiOpt(mitZiel, kosten);
  const fertig = orOpt(nach2opt, kosten);
  return { folge: fertig, kosten: folgeKosten(fertig, kosten) };
}
