// Praxen aus OpenStreetMap holen (Overpass API, kostenlos, kein Schlüssel).
//
// Grenzen offen benannt: OSM ist Freiwilligenarbeit. In deutschen Städten sind
// Arztpraxen gut, aber nicht vollständig erfasst — rechne mit 60–85 % der
// tatsächlich existierenden Praxen, und bei einem Teil davon fehlen Telefon
// oder Fachrichtung. Wer Vollständigkeit braucht, schaltet zusätzlich den
// Google-Places-Import zu (siehe sources/places.ts); die Dedup-Logik führt
// beide Quellen über den Adress-Schlüssel zusammen.

import type { DienstKonfig } from './dienste';
import { haversineM, type Punkt } from './geo';
import type { Kategorie, PraxisEingang } from './typen';

interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/** Tag-Gruppen werden einzeln abgefragt — ein großer Query timeoutet öfter. */
const TAG_GRUPPEN: Array<{ name: string; filter: string[] }> = [
  {
    name: 'Arztpraxen',
    filter: ['["amenity"="doctors"]', '["healthcare"="doctor"]'],
  },
  {
    name: 'Physiotherapie',
    filter: [
      '["healthcare"="physiotherapist"]',
      '["amenity"="physiotherapist"]',
      '["healthcare:speciality"~"physiotherapy",i]',
    ],
  },
  {
    name: 'Ärztehäuser, MVZ, Dialyse',
    filter: [
      '["healthcare"="centre"]',
      '["amenity"="clinic"]',
      '["healthcare"="dialysis"]',
      '["healthcare"="hospital"]',
    ],
  },
  {
    name: 'Pflege',
    filter: [
      '["amenity"="nursing_home"]',
      '["social_facility"="nursing_home"]',
      '["healthcare"="nursing_home"]',
      '["social_facility"~"assisted_living|group_home"]',
    ],
  },
];

/**
 * OSM-Fachrichtungen → deutsche Bezeichnung. Nur das, was für Krankenfahrten
 * eine Rolle spielt, ist hier vollständig; alles andere landet als Rohwert im
 * Feld "fachrichtung".
 */
const FACH_LABEL: Record<string, string> = {
  general: 'Allgemeinmedizin',
  general_practitioner: 'Allgemeinmedizin',
  gp: 'Allgemeinmedizin',
  family: 'Allgemeinmedizin',
  internal: 'Innere Medizin',
  nephrology: 'Nephrologie / Dialyse',
  dialysis: 'Dialyse',
  oncology: 'Onkologie',
  radiotherapy: 'Strahlentherapie',
  haematology: 'Hämatologie',
  neurology: 'Neurologie',
  orthopaedics: 'Orthopädie',
  cardiology: 'Kardiologie',
  geriatrics: 'Geriatrie',
  diabetology: 'Diabetologie',
  physiotherapy: 'Physiotherapie',
  paediatrics: 'Kinderheilkunde',
  gynaecology: 'Gynäkologie',
  dentist: 'Zahnmedizin',
  ophthalmology: 'Augenheilkunde',
  dermatology: 'Dermatologie',
  psychiatry: 'Psychiatrie',
  psychotherapy: 'Psychotherapie',
  otolaryngology: 'HNO',
  urology: 'Urologie',
  surgery: 'Chirurgie',
  radiology: 'Radiologie',
};

/** Fachrichtungen mit regelmäßigen, wiederkehrenden Fahrten. */
const PRIO_FACH = [
  'nephrology',
  'dialysis',
  'oncology',
  'radiotherapy',
  'haematology',
  'geriatrics',
];

/** Allgemeinmedizin in allen Schreibweisen, die OSM führt. */
const HAUSARZT_FACH = ['general', 'general_practitioner', 'gp', 'family'];

const HAUSARZT_NAME = /hausarzt|hausärzt|allgemeinmedizin|allgemeinärzt|allgemeinarzt|praxis für allgemein/i;
const PHYSIO_NAME = /physiotherap|physio\b|krankengymnastik|manuelle therapie/i;
const DIALYSE_NAME = /dialyse|nephrolog|kfh|nierenzentrum/i;
const ONKO_NAME = /onkolog|strahlenther|radioonkolog|hämatolog|haematolog/i;
const AERZTEHAUS_NAME = /ärztehaus|aerztehaus|mvz|medizinisches versorgungszentrum|gesundheitszentrum|praxiszentrum|facharztzentrum/i;
const PFLEGE_NAME = /pflegeheim|seniorenheim|senioren(zentrum|residenz|stift)|altenheim|pflegedienst|pflegezentrum|wohnstift/i;

function specialities(tags: Record<string, string>): string[] {
  const roh = [
    tags['healthcare:speciality'],
    tags['healthcare:speciality:de'],
    tags['medical_system:speciality'],
  ]
    .filter(Boolean)
    .join(';');
  return roh
    .split(/[;,]/)
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Einordnung eines OSM-Objekts. Bewusst großzügig in Richtung "mitnehmen":
 * Ein zu Unrecht mitgenommener Stopp kostet fünf Minuten, ein übersehener
 * Hausarzt kostet den Auftrag. Die Fachrichtung steht am Stopp, damit im Auto
 * erkennbar ist, was sich hinter der Tür verbirgt.
 */
export function einordnen(tags: Record<string, string>): Kategorie | null {
  const name = tags.name || tags.operator || '';
  const fach = specialities(tags);
  const istArzt = tags.amenity === 'doctors' || tags.healthcare === 'doctor';
  const istPhysioTag =
    tags.healthcare === 'physiotherapist' ||
    tags.amenity === 'physiotherapist' ||
    fach.includes('physiotherapy');
  const istZentrum =
    tags.healthcare === 'centre' ||
    tags.amenity === 'clinic' ||
    tags.healthcare === 'hospital';
  const istPflegeTag =
    tags.amenity === 'nursing_home' ||
    tags.healthcare === 'nursing_home' ||
    (tags.social_facility ?? '').length > 0;

  // Dialyse/Onkologie zuerst: diese Einrichtungen tragen oft zugleich
  // clinic- oder doctors-Tags, sollen aber nicht als "Klinik" untergehen.
  if (
    tags.healthcare === 'dialysis' ||
    fach.some(f => PRIO_FACH.includes(f)) ||
    DIALYSE_NAME.test(name) ||
    ONKO_NAME.test(name)
  ) {
    return 'prio_facharzt';
  }

  if (istPhysioTag || (PHYSIO_NAME.test(name) && !istArzt)) return 'physio';

  if (istArzt) {
    if (fach.some(f => HAUSARZT_FACH.includes(f))) return 'hausarzt';
    if (HAUSARZT_NAME.test(name)) return 'hausarzt';
    if (fach.length === 0) return 'arzt_unklar';
    // Innere Medizin ohne weitere Angabe sind in Deutschland sehr häufig
    // hausärztlich tätige Internisten.
    if (fach.includes('internal')) return 'hausarzt';
    if (AERZTEHAUS_NAME.test(name)) return 'aerztehaus';
    return 'facharzt';
  }

  if (istZentrum) {
    if (PFLEGE_NAME.test(name)) return 'pflege';
    return 'aerztehaus';
  }

  if (istPflegeTag || PFLEGE_NAME.test(name)) return 'pflege';

  return null;
}

export function fachrichtungText(tags: Record<string, string>): string | undefined {
  const fach = specialities(tags);
  if (fach.length === 0) return undefined;
  return fach.map(f => FACH_LABEL[f] || f).join(', ');
}

/**
 * Adress-Schlüssel: Ein Stopp ist eine Tür, nicht eine Praxis. Drei Praxen im
 * selben Haus werden zu einem Halt zusammengefasst, sonst fährt die Tour
 * dreimal dieselbe Adresse an.
 */
export function adressKey(p: {
  strasse?: string;
  hausnummer?: string;
  plz?: string;
  lat: number;
  lon: number;
}): string {
  const norm = (s?: string) =>
    (s || '')
      .toLowerCase()
      .replace(/ß/g, 'ss')
      .replace(/str\.?\b/g, 'strasse')
      .replace(/[^a-z0-9äöü]/g, '');
  if (p.strasse && p.hausnummer) {
    return `a:${norm(p.strasse)}-${norm(p.hausnummer)}-${norm(p.plz)}`;
  }
  // Ohne Hausnummer bleibt nur die Koordinate. Vier Dezimalstellen ≈ 11 m:
  // genau genug, um dasselbe Gebäude zu treffen, ohne Nachbarn einzusammeln.
  return `g:${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function overpassAbfrage(
  query: string,
  dienste: DienstKonfig,
): Promise<OverpassElement[]> {
  let letzterFehler: unknown;
  // Overpass ist ein geteilter Gratis-Dienst und drosselt unter Last (429/504).
  const wartezeiten = [0, 4000, 12000];
  for (const warten of wartezeiten) {
    if (warten) await sleep(warten);
    for (const endpoint of dienste.overpassEndpoints) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': dienste.userAgent,
          },
          body: 'data=' + encodeURIComponent(query),
          signal: AbortSignal.timeout(180_000),
        });
        if (!res.ok) {
          letzterFehler = new Error(`Overpass ${res.status} bei ${endpoint}`);
          continue;
        }
        const daten = (await res.json()) as { elements?: OverpassElement[] };
        return daten.elements ?? [];
      } catch (err) {
        letzterFehler = err;
      }
    }
  }
  throw letzterFehler instanceof Error
    ? letzterFehler
    : new Error('Overpass nicht erreichbar');
}

function query(filter: string[], mitte: Punkt, radiusKm: number): string {
  const um = `(around:${Math.round(radiusKm * 1000)},${mitte.lat},${mitte.lon})`;
  const zeilen = filter.map(f => `  nwr${f}${um};`).join('\n');
  return `[out:json][timeout:170];\n(\n${zeilen}\n);\nout center tags;`;
}

function koordinate(el: OverpassElement): Punkt | null {
  if (typeof el.lat === 'number' && typeof el.lon === 'number') {
    return { lat: el.lat, lon: el.lon };
  }
  if (el.center) return { lat: el.center.lat, lon: el.center.lon };
  return null;
}

export interface OsmErgebnis {
  praxen: PraxisEingang[];
  /** Pro Tag-Gruppe: wie viele Objekte kamen zurück, wie viele waren brauchbar. */
  gruppen: Array<{ name: string; objekte: number; uebernommen: number; fehler?: string }>;
}

/** Holt alle relevanten Einrichtungen im Radius um den Betriebssitz. */
export async function osmImport(
  mitte: Punkt,
  radiusKm: number,
  dienste: DienstKonfig,
  melde: (text: string) => void = () => {},
  /**
   * Wird nach jeder Tag-Gruppe mit dem Zwischenstand aufgerufen.
   *
   * Ohne das stünde in der Anzeige die ganze Laufzeit über "Gefunden: 0",
   * während im Protokoll darüber schon "17 übernommen" steht — das sieht aus
   * wie ein Fehler, ist aber nur eine Zahl, die zu spät kommt.
   */
  aufGruppe: (zwischenstand: { gefunden: number }) => void = () => {},
): Promise<OsmErgebnis> {
  const praxen: PraxisEingang[] = [];
  const gruppen: OsmErgebnis['gruppen'] = [];
  const gesehen = new Set<string>();

  for (let i = 0; i < TAG_GRUPPEN.length; i++) {
    const gruppe = TAG_GRUPPEN[i];
    if (i > 0) await sleep(3000); // Gratis-Dienst nicht überfahren
    melde(`OpenStreetMap: ${gruppe.name} …`);
    try {
      const elemente = await overpassAbfrage(query(gruppe.filter, mitte, radiusKm), dienste);
      let uebernommen = 0;
      for (const el of elemente) {
        const tags = el.tags ?? {};
        const name = tags.name || tags.operator;
        // Ohne Namen kann man an der Tür nichts suchen und niemanden ansprechen.
        if (!name) continue;
        const kategorie = einordnen(tags);
        if (!kategorie) continue;
        const punkt = koordinate(el);
        if (!punkt) continue;
        const id = `osm:${el.type}/${el.id}`;
        if (gesehen.has(id)) continue;
        gesehen.add(id);
        praxen.push({
          id,
          name,
          kategorie,
          fachrichtung: fachrichtungText(tags),
          strasse: tags['addr:street'],
          hausnummer: tags['addr:housenumber'],
          plz: tags['addr:postcode'],
          ort: tags['addr:city'],
          stadtteil: tags['addr:suburb'] || tags['addr:city_district'],
          lat: punkt.lat,
          lon: punkt.lon,
          telefon: tags.phone || tags['contact:phone'] || tags['contact:mobile'],
          website: tags.website || tags['contact:website'],
          email: tags.email || tags['contact:email'],
          oeffnungszeiten: tags.opening_hours,
          barrierefrei: tags.wheelchair,
          quelle: 'osm',
          source_url: `https://www.openstreetmap.org/${el.type}/${el.id}`,
        });
        uebernommen++;
      }
      gruppen.push({ name: gruppe.name, objekte: elemente.length, uebernommen });
      melde(`OpenStreetMap: ${gruppe.name} – ${uebernommen} übernommen`);
      aufGruppe({ gefunden: praxen.length });
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      gruppen.push({ name: gruppe.name, objekte: 0, uebernommen: 0, fehler: text });
      melde(`OpenStreetMap: ${gruppe.name} – FEHLER: ${text}`);
    }
  }

  // Luftlinie als schnelles Sortierkriterium; die echten Fahrzeiten kommen
  // später von OSRM.
  for (const p of praxen) {
    (p as PraxisEingang & { entfernung_m?: number }).entfernung_m = Math.round(
      haversineM(mitte, p),
    );
  }

  return { praxen, gruppen };
}
