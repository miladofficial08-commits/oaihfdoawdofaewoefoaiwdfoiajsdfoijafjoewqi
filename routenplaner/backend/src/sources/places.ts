// Optionaler Zusatz-Import über die Google Places API (New).
//
// Warum überhaupt: OpenStreetMap kennt viele, aber nicht alle Arztpraxen.
// Google kennt praktisch jede, die ein Google-Profil hat — in Deutschland die
// große Mehrheit. Ohne diesen Import bleibt die Liste unvollständig, mit ihm
// kommt sie sehr nah an vollständig.
//
// Was es kostet (bitte im eigenen Google-Konto gegenprüfen, Preise ändern
// sich): "Nearby Search (New)" wird pro Anfrage abgerechnet, Größenordnung
// 30–35 USD pro 1.000 Anfragen, mit monatlichem Freibetrag. Eine Anfrage
// liefert maximal 20 Treffer, deshalb wird die Fläche in überlappende Zellen
// zerlegt. /api/import/kosten rechnet die Anfragen vorher aus, damit niemand
// versehentlich ein größeres Gebiet abfragt als gedacht.

import { config } from '../config';
import { haversineM, type Punkt } from '../geo';
import type { Kategorie, PraxisEingang } from '../typen';

const ENDPOINT = 'https://places.googleapis.com/v1/places:searchNearby';

/**
 * Google-Typen in Gruppen. Getrennt abgefragt, weil eine Anfrage nur
 * 20 Treffer liefert: Arztpraxen und Physios würden sich sonst gegenseitig
 * aus dem Ergebnis drängen.
 */
const TYP_GRUPPEN: Array<{ name: string; typen: string[]; standard: Kategorie }> = [
  { name: 'Arztpraxen', typen: ['doctor'], standard: 'arzt_unklar' },
  { name: 'Physiotherapie', typen: ['physiotherapist'], standard: 'physio' },
  { name: 'Kliniken & Ärztehäuser', typen: ['hospital'], standard: 'aerztehaus' },
];

const FELDER = [
  'places.id',
  'places.displayName',
  'places.shortFormattedAddress',
  'places.addressComponents',
  'places.location',
  'places.nationalPhoneNumber',
  'places.websiteUri',
  'places.primaryType',
  'places.types',
  'places.businessStatus',
].join(',');

interface PlaceRoh {
  id: string;
  displayName?: { text?: string };
  shortFormattedAddress?: string;
  addressComponents?: Array<{ longText?: string; shortText?: string; types?: string[] }>;
  location?: { latitude: number; longitude: number };
  nationalPhoneNumber?: string;
  websiteUri?: string;
  primaryType?: string;
  types?: string[];
  businessStatus?: string;
}

const RE_HAUSARZT = /hausarzt|hausärzt|hausaerzt|allgemeinmedizin|allgemeinärzt|allgemeinarzt|innere medizin|internist/i;
const RE_PHYSIO = /physiotherap|physio\b|krankengymnastik|manuelle therapie|ergotherap/i;
const RE_PRIO = /dialyse|nephrolog|onkolog|strahlenther|radioonkolog|hämatolog|haematolog|nierenzentrum|kfh/i;
const RE_AERZTEHAUS = /ärztehaus|aerztehaus|\bmvz\b|medizinisches versorgungszentrum|gesundheitszentrum|praxiszentrum|facharztzentrum|poliklinik/i;
const RE_PFLEGE = /pflegeheim|seniorenheim|senioren(zentrum|residenz|stift)|altenheim|pflegedienst|pflegezentrum|wohnstift|hospiz/i;
const RE_FACHARZT = /zahnarzt|zahnärzt|zahnmedizin|kieferorthopäd|augenarzt|augenärzt|augenheilkunde|hautarzt|hautärzt|dermatolog|frauenarzt|frauenärzt|gynäkolog|kinderarzt|kinderärzt|kinder- und jugend|hno|hals-nasen|urolog|psychiater|psychotherap|psychiatrie|radiolog|chirurg|tierarzt|tierärzt|heilpraktiker|logopäd|podolog/i;

/**
 * Einordnung eines Google-Treffers. Google liefert keine Fachrichtung, nur
 * grobe Typen — die Fachrichtung steckt in Deutschland fast immer im Namen
 * ("Praxis für Allgemeinmedizin Dr. …"), deshalb wird der Name ausgewertet.
 */
export function einordnenGoogle(
  name: string,
  typen: string[],
  standard: Kategorie,
): Kategorie | null {
  if (typen.includes('veterinary_care') || /tierarzt|tierärzt|tierklinik/i.test(name)) {
    return null;
  }
  if (RE_PFLEGE.test(name)) return 'pflege';
  if (RE_PRIO.test(name)) return 'prio_facharzt';
  if (typen.includes('physiotherapist') || RE_PHYSIO.test(name)) return 'physio';
  if (RE_HAUSARZT.test(name)) return 'hausarzt';
  if (typen.includes('dentist') || RE_FACHARZT.test(name)) return 'facharzt';
  if (RE_AERZTEHAUS.test(name)) return 'aerztehaus';
  if (typen.includes('hospital')) return 'aerztehaus';
  // Praxis ohne erkennbare Fachrichtung: mitnehmen, nicht wegwerfen. Darunter
  // sind überproportional viele Hausärzte, die ihre Fachrichtung nicht in den
  // Namen schreiben.
  return standard;
}

/**
 * Zellen-Mittelpunkte, die einen Kreis abdecken. Die Zellen überlappen
 * bewusst (Gitterabstand 1,4 × Zellradius), sonst entstehen an den Rändern
 * Löcher, in denen Praxen verschwinden.
 */
export function zellen(mitte: Punkt, radiusKm: number, zellRadiusM: number): Punkt[] {
  const schrittKm = (zellRadiusM * 1.4) / 1000;
  const dLat = schrittKm / 111.32;
  const dLon = schrittKm / (111.32 * Math.max(0.01, Math.cos((mitte.lat * Math.PI) / 180)));
  const n = Math.ceil(radiusKm / schrittKm);
  const liste: Punkt[] = [];
  for (let i = -n; i <= n; i++) {
    for (let j = -n; j <= n; j++) {
      const p = { lat: mitte.lat + i * dLat, lon: mitte.lon + j * dLon };
      if (haversineM(mitte, p) <= radiusKm * 1000 + zellRadiusM) liste.push(p);
    }
  }
  return liste;
}

/** Vorschau: so viele Anfragen würde ein Lauf auslösen. */
export function anfragenSchaetzung(
  mitte: Punkt,
  radiusKm: number,
  zellRadiusM: number,
): number {
  return zellen(mitte, radiusKm, zellRadiusM).length * TYP_GRUPPEN.length;
}

function komponente(ort: PlaceRoh, typ: string): string | undefined {
  const k = ort.addressComponents?.find(c => c.types?.includes(typ));
  return k?.longText || k?.shortText;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export interface PlacesErgebnis {
  praxen: PraxisEingang[];
  anfragen: number;
  fehler: string[];
  /**
   * Zellen, die genau 20 Treffer geliefert haben. 20 ist das Maximum pro
   * Anfrage — dort steckt mit hoher Wahrscheinlichkeit mehr, was nicht
   * zurückkam. Wer diese Zahl über null sieht, sollte den Zellradius kleiner
   * setzen und den Lauf wiederholen.
   */
  volle_zellen: number;
}

export async function placesImport(
  mitte: Punkt,
  radiusKm: number,
  zellRadiusM = 700,
  melde: (text: string) => void = () => {},
): Promise<PlacesErgebnis> {
  if (!config.googlePlacesKey) {
    throw new Error('GOOGLE_PLACES_KEY ist nicht gesetzt – Google-Import nicht möglich.');
  }
  const gitter = zellen(mitte, radiusKm, zellRadiusM);
  const praxen = new Map<string, PraxisEingang>();
  const fehler: string[] = [];
  let anfragen = 0;
  let volleZellen = 0;

  for (const gruppe of TYP_GRUPPEN) {
    for (let i = 0; i < gitter.length; i++) {
      const zelle = gitter[i];
      if (anfragen > 0) await sleep(120);
      anfragen++;
      if (i % 20 === 0) {
        melde(`Google: ${gruppe.name} – Zelle ${i + 1}/${gitter.length} (${praxen.size} gefunden)`);
      }
      try {
        const res = await fetch(ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': config.googlePlacesKey,
            'X-Goog-FieldMask': FELDER,
          },
          body: JSON.stringify({
            includedTypes: gruppe.typen,
            maxResultCount: 20,
            locationRestriction: {
              circle: {
                center: { latitude: zelle.lat, longitude: zelle.lon },
                radius: zellRadiusM,
              },
            },
            languageCode: 'de',
            regionCode: 'DE',
          }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) {
          const text = (await res.text()).slice(0, 200);
          fehler.push(`${gruppe.name}: HTTP ${res.status} ${text}`);
          // Bei Schlüssel- oder Abrechnungsfehlern bringt Weitermachen nichts
          // außer weiteren Fehlern — abbrechen und zurückgeben, was da ist.
          if (res.status === 401 || res.status === 403) {
            return { praxen: [...praxen.values()], anfragen, fehler, volle_zellen: volleZellen };
          }
          continue;
        }
        const daten = (await res.json()) as { places?: PlaceRoh[] };
        if ((daten.places?.length ?? 0) >= 20) volleZellen++;
        for (const ort of daten.places ?? []) {
          if (!ort.location || !ort.displayName?.text) continue;
          if (ort.businessStatus === 'CLOSED_PERMANENTLY') continue;
          const id = `google:${ort.id}`;
          if (praxen.has(id)) continue;
          const lat = ort.location.latitude;
          const lon = ort.location.longitude;
          // Die Zellen überlappen den Suchkreis am Rand — alles außerhalb
          // des eigentlichen Radius wieder rauswerfen.
          if (haversineM(mitte, { lat, lon }) > radiusKm * 1000) continue;
          const name = ort.displayName.text;
          const kategorie = einordnenGoogle(name, ort.types ?? [], gruppe.standard);
          if (!kategorie) continue;
          praxen.set(id, {
            id,
            name,
            kategorie,
            strasse: komponente(ort, 'route'),
            hausnummer: komponente(ort, 'street_number'),
            plz: komponente(ort, 'postal_code'),
            ort: komponente(ort, 'locality'),
            stadtteil: komponente(ort, 'sublocality') || komponente(ort, 'sublocality_level_1'),
            lat,
            lon,
            telefon: ort.nationalPhoneNumber,
            website: ort.websiteUri,
            quelle: 'google',
            source_url: `https://www.google.com/maps/place/?q=place_id:${ort.id}`,
          });
        }
      } catch (err) {
        fehler.push(`${gruppe.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  if (volleZellen > 0) {
    fehler.push(
      `${volleZellen} Zellen waren mit 20 Treffern voll – dort fehlen vermutlich Praxen. ` +
        `Zellradius kleiner setzen (z. B. 400 m) und erneut laufen lassen.`,
    );
  }
  return { praxen: [...praxen.values()], anfragen, fehler, volle_zellen: volleZellen };
}
