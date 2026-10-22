// Praxenbestand als einfache Listen statt als Datenbank.
//
// Netlify hat keine Datenbank, sondern einen Key-Value-Speicher: eine
// JSON-Datei rein, eine JSON-Datei raus. Damit darin nicht dieselben Regeln
// ein zweites Mal — und anders — entstehen, steht die ganze Logik hier als
// reine Funktionen. Die Funktion liest, ruft auf, schreibt zurück.
//
// Dieselben Regeln wie in der SQL-Fassung:
//  • Gleiche Quell-ID      → Felder auffrischen, Lücken füllen.
//  • Gleiche Adresse + ähnlicher Name + verträgliche Kategorie → dieselbe Praxis.
//  • Sonst                 → neuer Datensatz.
// Und in jedem Fall: ein Import löscht niemals einen Besuchsstand.

import { gleichePraxis, kategorienVertraeglich } from './dedup';
import { haversineM, type Punkt } from './geo';
import { adressKey } from './overpass';
import type { PraxisAusgang, PraxisEingang, Status } from './typen';

/** Eine gespeicherte Praxis: Eingangsdaten plus das, was beim Ablegen entsteht. */
export interface PraxisSatz extends PraxisEingang {
  adress_key: string;
  entfernung_m: number;
  geaendert_am: string;
  aktiv: boolean;
}

/** Besuchsstand einer Praxis. */
export interface Besuch {
  status: Status;
  notiz?: string | null;
  ansprechpartner?: string | null;
  potenzial?: number | null;
  material_da?: boolean;
  wiedervorlage?: string | null;
  bearbeiter?: string | null;
  besucht_am?: string | null;
  geaendert_am: string;
}

export type BesuchsBuch = Record<string, Besuch>;

export interface ImportBilanz {
  neu: number;
  aktualisiert: number;
  zusammengefuehrt: number;
}

/** Vorhandenes gewinnt, Lücken werden gefüllt — wie COALESCE in der SQL-Fassung. */
function ergaenze<T>(vorhanden: T | undefined | null, neu: T | undefined | null): T | undefined {
  return (vorhanden ?? neu) ?? undefined;
}

/**
 * Neue Treffer in den Bestand einarbeiten. Gibt eine neue Liste zurück und
 * verändert die übergebene nicht — damit ein Fehler mittendrin nicht einen
 * halb veränderten Bestand hinterlässt.
 */
export function zusammenfuehren(
  bestand: PraxisSatz[],
  eingang: PraxisEingang[],
  betriebssitz: Punkt,
  jetzt = new Date().toISOString(),
): { bestand: PraxisSatz[]; bilanz: ImportBilanz } {
  const liste = bestand.map(p => ({ ...p }));
  const nachId = new Map(liste.map((p, i) => [p.id, i]));
  const nachAdresse = new Map<string, number[]>();
  liste.forEach((p, i) => {
    const vorhandene = nachAdresse.get(p.adress_key);
    if (vorhandene) vorhandene.push(i);
    else nachAdresse.set(p.adress_key, [i]);
  });

  const bilanz: ImportBilanz = { neu: 0, aktualisiert: 0, zusammengefuehrt: 0 };

  const auffrischen = (index: number, neu: PraxisEingang) => {
    const alt = liste[index];
    liste[index] = {
      ...alt,
      telefon: ergaenze(alt.telefon, neu.telefon),
      website: ergaenze(alt.website, neu.website),
      email: ergaenze(alt.email, neu.email),
      fachrichtung: ergaenze(alt.fachrichtung, neu.fachrichtung),
      strasse: ergaenze(alt.strasse, neu.strasse),
      hausnummer: ergaenze(alt.hausnummer, neu.hausnummer),
      plz: ergaenze(alt.plz, neu.plz),
      ort: ergaenze(alt.ort, neu.ort),
      stadtteil: ergaenze(alt.stadtteil, neu.stadtteil),
      oeffnungszeiten: ergaenze(alt.oeffnungszeiten, neu.oeffnungszeiten),
      barrierefrei: ergaenze(alt.barrierefrei, neu.barrierefrei),
      // Eine unklare Fachrichtung darf durch eine klare ersetzt werden,
      // umgekehrt nicht: Google weiß oft, was OSM offenlässt.
      kategorie:
        alt.kategorie === 'arzt_unklar' && neu.kategorie !== 'arzt_unklar'
          ? neu.kategorie
          : alt.kategorie,
      quelle: alt.quelle.includes(neu.quelle)
        ? alt.quelle
        : ((alt.quelle + '+' + neu.quelle) as PraxisSatz['quelle']),
      geaendert_am: jetzt,
    };
  };

  for (const neu of eingang) {
    const key = adressKey(neu);
    const treffer = nachId.get(neu.id);
    if (treffer !== undefined) {
      auffrischen(treffer, neu);
      bilanz.aktualisiert++;
      continue;
    }

    const nachbarn = nachAdresse.get(key) ?? [];
    const gleich = nachbarn.find(
      i => kategorienVertraeglich(liste[i].kategorie, neu.kategorie) &&
           gleichePraxis(liste[i].name, neu.name),
    );
    if (gleich !== undefined) {
      auffrischen(gleich, neu);
      bilanz.zusammengefuehrt++;
      continue;
    }

    const satz: PraxisSatz = {
      ...neu,
      adress_key: key,
      entfernung_m: Math.round(haversineM(betriebssitz, neu)),
      geaendert_am: jetzt,
      aktiv: true,
    };
    liste.push(satz);
    nachId.set(satz.id, liste.length - 1);
    const vorhandene = nachAdresse.get(key);
    if (vorhandene) vorhandene.push(liste.length - 1);
    else nachAdresse.set(key, [liste.length - 1]);
    bilanz.neu++;
  }

  return { bestand: liste, bilanz };
}

export interface PraxenFilter {
  kategorien?: string[];
  maxEntfernungM?: number;
  status?: Status[];
}

/** Bestand und Besuchsbuch zu dem zusammensetzen, was die Oberfläche anzeigt. */
export function zusammenstellen(
  bestand: PraxisSatz[],
  besuche: BesuchsBuch,
  filter: PraxenFilter = {},
): PraxisAusgang[] {
  const ergebnis: PraxisAusgang[] = [];
  for (const p of bestand) {
    if (!p.aktiv) continue;
    if (filter.kategorien?.length && !filter.kategorien.includes(p.kategorie)) continue;
    if (typeof filter.maxEntfernungM === 'number' && p.entfernung_m > filter.maxEntfernungM) {
      continue;
    }
    const b = besuche[p.id];
    const status: Status = b?.status ?? 'offen';
    if (filter.status?.length && !filter.status.includes(status)) continue;
    ergebnis.push({
      ...p,
      status,
      notiz: b?.notiz ?? null,
      ansprechpartner: b?.ansprechpartner ?? null,
      potenzial: b?.potenzial ?? null,
      material_da: b?.material_da ? 1 : 0,
      wiedervorlage: b?.wiedervorlage ?? null,
      bearbeiter: b?.bearbeiter ?? null,
      besucht_am: b?.besucht_am ?? null,
    });
  }
  return ergebnis.sort((a, b) => (a.entfernung_m ?? 0) - (b.entfernung_m ?? 0));
}

export interface BesuchAenderung {
  status?: Status;
  notiz?: string | null;
  ansprechpartner?: string | null;
  potenzial?: number | null;
  material_da?: boolean;
  wiedervorlage?: string | null;
  bearbeiter?: string | null;
}

/**
 * Besuchsstand ändern. Nicht übergebene Felder bleiben stehen — wer nur eine
 * Notiz nachträgt, darf damit nicht den Status zurücksetzen.
 */
export function besuchAnwenden(
  besuche: BesuchsBuch,
  praxisId: string,
  aenderung: BesuchAenderung,
  jetzt = new Date().toISOString(),
): BesuchsBuch {
  const alt = besuche[praxisId];
  const neu: Besuch = {
    status: alt?.status ?? 'offen',
    notiz: alt?.notiz ?? null,
    ansprechpartner: alt?.ansprechpartner ?? null,
    potenzial: alt?.potenzial ?? null,
    material_da: alt?.material_da ?? false,
    wiedervorlage: alt?.wiedervorlage ?? null,
    bearbeiter: alt?.bearbeiter ?? null,
    besucht_am: alt?.besucht_am ?? null,
    geaendert_am: jetzt,
  };

  if (aenderung.status !== undefined) {
    neu.status = aenderung.status;
    // Zeitstempel beim ersten echten Besuch setzen, bei "offen" wieder weg.
    if (aenderung.status === 'offen') neu.besucht_am = null;
    else neu.besucht_am = neu.besucht_am ?? jetzt;
  }
  if (aenderung.notiz !== undefined) neu.notiz = aenderung.notiz;
  if (aenderung.ansprechpartner !== undefined) neu.ansprechpartner = aenderung.ansprechpartner;
  if (aenderung.potenzial !== undefined) neu.potenzial = aenderung.potenzial;
  if (aenderung.material_da !== undefined) neu.material_da = aenderung.material_da;
  if (aenderung.wiedervorlage !== undefined) neu.wiedervorlage = aenderung.wiedervorlage;
  if (aenderung.bearbeiter !== undefined) neu.bearbeiter = aenderung.bearbeiter;

  return { ...besuche, [praxisId]: neu };
}

/** Zahlen für die Übersicht. */
export function statistikAus(bestand: PraxisSatz[], besuche: BesuchsBuch) {
  const aktiv = bestand.filter(p => p.aktiv);
  const nachStatus: Record<string, number> = {};
  const nachKategorie: Record<string, number> = {};
  const nachQuelle: Record<string, number> = {};
  for (const p of aktiv) {
    const status = besuche[p.id]?.status ?? 'offen';
    nachStatus[status] = (nachStatus[status] ?? 0) + 1;
    nachKategorie[p.kategorie] = (nachKategorie[p.kategorie] ?? 0) + 1;
    nachQuelle[p.quelle] = (nachQuelle[p.quelle] ?? 0) + 1;
  }
  return {
    gesamt: aktiv.length,
    mitTelefon: aktiv.filter(p => p.telefon).length,
    nachStatus,
    nachKategorie,
    nachQuelle,
  };
}
