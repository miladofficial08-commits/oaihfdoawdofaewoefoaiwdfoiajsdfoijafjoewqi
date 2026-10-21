// Kostenloser Lead-Scraper über die OpenStreetMap Overpass API.
//
// Zweck: Für die Consult-Strategie (Vor-Ort-Besuche) brauchen wir vor allem
// ADRESSE + TELEFON lokaler Firmen — genau das liefert OSM gratis und ohne Key.
// E-Mails sind in OSM selten; wer die für E-Mail-Outreach braucht, nutzt den
// Apify-Scraper. OSM ist die Besuchs-/Anrufliste.

import { upsertLead } from '../db/leads-repo';

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

// Bounding-Box je Stadt: [Süd, West, Nord, Ost]. BBox-Queries sind massiv
// schneller als area["name"=...]-Lookups (die auf den überlasteten Gratis-Servern
// zu 504-Timeouts führen). Neue Städte hier ergänzen.
const STADT_BBOX: Record<string, [number, number, number, number]> = {
  'düsseldorf': [51.12, 6.68, 51.35, 6.94],
  'duesseldorf': [51.12, 6.68, 51.35, 6.94],
};

// Branche → OSM-Tags. OSM ist inkonsistent, daher teils mehrere Tags pro Branche.
export const OSM_BRANCHEN: Record<string, { label: string; tags: Array<[string, string]> }> = {
  immobilienmakler: { label: 'Immobilienmakler', tags: [['office', 'estate_agent']] },
  autohaeuser: { label: 'Autohäuser', tags: [['shop', 'car']] },
  steuerberater: {
    label: 'Steuerberater',
    tags: [['office', 'tax_advisor'], ['office', 'accountant']],
  },
};

interface OverpassElement {
  type: string;
  id: number;
  tags?: Record<string, string>;
}

function buildQuery(tags: Array<[string, string]>, stadt: string): string {
  const bbox = STADT_BBOX[stadt.trim().toLowerCase()];
  if (bbox) {
    const b = bbox.join(',');
    const filters = tags.map(([k, v]) => `  nwr["${k}"="${v}"](${b});`).join('\n');
    return `[out:json][timeout:60];\n(\n${filters}\n);\nout center tags;`;
  }
  // Fallback für Städte ohne hinterlegte BBox: area-Lookup (langsamer, kann timeouten).
  const filters = tags.map(([k, v]) => `  nwr["${k}"="${v}"](area.a);`).join('\n');
  return `[out:json][timeout:90];
area["name"="${stadt}"]["boundary"="administrative"]->.a;
(
${filters}
);
out center tags;`;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function runOverpass(query: string): Promise<OverpassElement[]> {
  let lastErr: unknown;
  // Overpass ist ein geteilter Gratis-Dienst und drosselt (429) bei Last.
  // Daher mehrere Runden mit steigender Wartezeit über beide Spiegel.
  const backoffs = [0, 3000, 8000];
  for (const wait of backoffs) {
    if (wait) await sleep(wait);
    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(query),
        });
        if (res.status === 429 || res.status === 504) {
          lastErr = new Error(`Overpass ${res.status} (Drosselung)`);
          continue;
        }
        if (!res.ok) {
          lastErr = new Error(`Overpass ${res.status}`);
          continue;
        }
        const data = (await res.json()) as { elements?: OverpassElement[] };
        return data.elements ?? [];
      } catch (err) {
        lastErr = err;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Overpass nicht erreichbar');
}

function buildAddress(t: Record<string, string>): string | undefined {
  const street = [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(' ');
  const cityLine = [t['addr:postcode'], t['addr:city']].filter(Boolean).join(' ');
  const full = [street, cityLine].filter(Boolean).join(', ');
  return full || undefined;
}

function elementToLead(el: OverpassElement, brancheLabel: string, stadt: string) {
  const t = el.tags ?? {};
  const name = t.name || t['operator'] || '';
  if (!name) return null; // ohne Namen unbrauchbar
  const telefon = t.phone || t['contact:phone'] || t['contact:mobile'] || undefined;
  const website = t.website || t['contact:website'] || undefined;
  const email = t.email || t['contact:email'] || undefined;
  return {
    maps_place_id: `osm:${el.type}/${el.id}`, // eigener Namespace → greift in Dedup
    name,
    branche: brancheLabel,
    stadt: t['addr:city'] || stadt,
    adresse: buildAddress(t),
    telefon,
    website,
    email,
    track: 'consult',
    source_url: `https://www.openstreetmap.org/${el.type}/${el.id}`,
  };
}

export interface OsmScrapeResult {
  branche: string;
  found: number;
  inserted: number;
  withPhone: number;
  withWebsite: number;
  error?: string;
}

export async function scrapeOsm(brancheKey: string, stadt: string): Promise<OsmScrapeResult> {
  const cfg = OSM_BRANCHEN[brancheKey];
  if (!cfg) throw new Error(`Unbekannte OSM-Branche "${brancheKey}". Verfügbar: ${Object.keys(OSM_BRANCHEN).join(', ')}`);
  const result: OsmScrapeResult = { branche: cfg.label, found: 0, inserted: 0, withPhone: 0, withWebsite: 0 };
  try {
    const elements = await runOverpass(buildQuery(cfg.tags, stadt));
    for (const el of elements) {
      const lead = elementToLead(el, cfg.label, stadt);
      if (!lead) continue;
      result.found++;
      const { inserted } = upsertLead(lead);
      if (inserted) result.inserted++;
      if (lead.telefon) result.withPhone++;
      if (lead.website) result.withWebsite++;
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  return result;
}

/** Läuft alle (oder ausgewählte) Consult-Branchen in einer Stadt ab. */
export async function scrapeOsmBranchen(stadt: string, brancheKeys = Object.keys(OSM_BRANCHEN)): Promise<OsmScrapeResult[]> {
  const rows: OsmScrapeResult[] = [];
  for (let i = 0; i < brancheKeys.length; i++) {
    if (i > 0) await sleep(2500); // Pause zwischen Branchen – schont den Gratis-Dienst
    const r = await scrapeOsm(brancheKeys[i], stadt);
    if (r.error) console.log(`  ${r.branche}: FEHLER – ${r.error}`);
    else console.log(`  ${r.branche}: ${r.found} gefunden (${r.inserted} neu, ${r.withPhone} mit Tel, ${r.withWebsite} mit Web)`);
    rows.push(r);
  }
  return rows;
}

// ── Handwerk in ganz NRW ─────────────────────────────────────────────────────
// Für den Voice-Agent-Track brauchen wir Betriebe, bei denen tatsächlich das
// Telefon klingelt und niemand rangehen kann: Elektro, SHK, Dach, Schreiner …
// OSM kennt davon rund 9.400 in NRW, knapp 5.000 mit Website – und die Website
// ist der Weg zur E-Mail (der Website-Checker liest Impressum/Kontakt aus).
//
// Kosten: null. Overpass ist ein Gratis-Dienst, deshalb wird pro Gewerk einzeln
// und mit Pausen abgefragt statt alles auf einmal.
export const HANDWERK_CRAFTS: Array<{ craft: string; label: string }> = [
  // Gebäudetechnik
  { craft: 'electrician', label: 'Elektriker' },
  { craft: 'plumber', label: 'Sanitär' },
  { craft: 'hvac', label: 'Heizung & Klima' },
  { craft: 'gasfitter', label: 'Gas- & Wasserinstallation' },
  { craft: 'heating_engineer', label: 'Heizungsbau' },
  { craft: 'ventilation', label: 'Lüftungsbau' },
  // Bau & Rohbau
  { craft: 'builder', label: 'Bauunternehmen' },
  { craft: 'bricklayer', label: 'Maurer' },
  { craft: 'concrete', label: 'Betonbau' },
  { craft: 'plasterer', label: 'Stuckateur' },
  { craft: 'well_drilling', label: 'Brunnenbau' },
  // Innenausbau
  { craft: 'painter', label: 'Maler' },
  { craft: 'tiler', label: 'Fliesenleger' },
  { craft: 'floorer', label: 'Bodenleger' },
  { craft: 'parquet_layer', label: 'Parkettleger' },
  { craft: 'insulation', label: 'Dämmung' },
  { craft: 'interior_decorator', label: 'Raumausstatter' },
  { craft: 'upholsterer', label: 'Polsterei' },
  { craft: 'dry_lining', label: 'Trockenbau' },
  // Holz & Metall
  { craft: 'carpenter', label: 'Zimmerei' },
  { craft: 'joiner', label: 'Schreinerei' },
  { craft: 'cabinet_maker', label: 'Möbelbau' },
  { craft: 'sawmill', label: 'Holzbau' },
  { craft: 'metal_construction', label: 'Metallbau' },
  { craft: 'blacksmith', label: 'Schmiede' },
  { craft: 'tinsmith', label: 'Klempnerei/Spenglerei' },
  { craft: 'glaziery', label: 'Glaserei' },
  { craft: 'window_construction', label: 'Fensterbau' },
  { craft: 'door_construction', label: 'Türenbau' },
  { craft: 'sun_protection', label: 'Rollladen & Sonnenschutz' },
  { craft: 'locksmith', label: 'Schlüsseldienst' },
  // Dach & Außenhülle
  { craft: 'roofer', label: 'Dachdecker' },
  { craft: 'scaffolder', label: 'Gerüstbau' },
  { craft: 'stonemason', label: 'Steinmetz' },
  { craft: 'chimney_sweeper', label: 'Schornsteinfeger' },
  // Außenanlagen
  { craft: 'gardener', label: 'Garten- & Landschaftsbau' },
  { craft: 'tree_service', label: 'Baumpflege' },
  // Service & Reinigung – ausdrücklich Handwerk im Sinne der Anrufliste:
  // Hier klingelt das Telefon für Angebote, und niemand kann rangehen.
  { craft: 'cleaning', label: 'Reinigung' },
  { craft: 'pest_control', label: 'Schädlingsbekämpfung' },
  { craft: 'handicraft', label: 'Handwerk (allgemein)' },
  { craft: 'rigger', label: 'Montage & Rigging' },
  { craft: 'signmaker', label: 'Werbetechnik' },
  { craft: 'electronics_repair', label: 'Elektronik-Reparatur' },
  { craft: 'agricultural_engines', label: 'Landmaschinentechnik' },
];

// ── Gewerke, die OSM nicht als craft=… kennt ────────────────────────────────
//
// Abbruch, Entkernung, Entrümpelung, Umzug, Containerdienst: dafür gibt es kein
// etabliertes OSM-Tag, die Betriebe stehen als office=company oder shop=trade
// drin. Gefunden werden sie über den Firmennamen – und zwar nur, wenn eine
// Telefonnummer dransteht. Das ist kein Kompromiss, sondern genau der Filter,
// den die Anrufliste braucht: ohne Nummer ist der Eintrag für Kaltakquise wertlos,
// und die Namenssuche über ganz NRW wird damit überhaupt erst bezahlbar schnell.
export const NAME_GEWERKE: Array<{ id: string; label: string; regex: string }> = [
  { id: 'abbruch', label: 'Abbruch & Entkernung', regex: 'Abbruch|Abriss|Entkernung|Rückbau|Rueckbau' },
  { id: 'entsorgung', label: 'Entsorgung & Container', regex: 'Containerdienst|Entsorgung|Schuttabfuhr|Recycling' },
  { id: 'entruempelung', label: 'Entrümpelung & Haushaltsauflösung', regex: 'Entrümpelung|Entruempelung|Haushaltsauflösung|Haushaltsaufloesung' },
  { id: 'umzug', label: 'Umzüge & Transport', regex: 'Umzug|Umzüge|Umzuege|Möbeltransport|Moebeltransport|Spedition' },
  { id: 'trockenbau', label: 'Trockenbau & Innenausbau', regex: 'Trockenbau|Innenausbau|Akustikbau' },
  { id: 'gebaeudereinigung', label: 'Gebäudereinigung', regex: 'Gebäudereinigung|Gebaeudereinigung|Reinigungsservice|Glasreinigung|Industriereinigung' },
  { id: 'estrich', label: 'Estrich & Bodenbau', regex: 'Estrich|Bodenbau|Fußbodentechnik|Fussbodentechnik' },
  { id: 'pflasterbau', label: 'Pflaster- & Außenanlagen', regex: 'Pflasterbau|Pflasterarbeiten|Außenanlagen|Aussenanlagen|Zaunbau' },
  { id: 'sanierung', label: 'Sanierung & Bautrocknung', regex: 'Sanierung|Bautrocknung|Schimmelsanierung|Wasserschaden|Brandschaden' },
  { id: 'rohrreinigung', label: 'Rohr- & Kanalreinigung', regex: 'Rohrreinigung|Kanalreinigung|Kanalsanierung|Rohrservice' },
  { id: 'hausmeister', label: 'Hausmeisterservice', regex: 'Hausmeisterservice|Hausmeister|Facility|Gebäudeservice|Gebaeudeservice' },
  { id: 'winterdienst', label: 'Winterdienst', regex: 'Winterdienst|Grünpflege|Gruenpflege' },
  { id: 'geruestbau', label: 'Gerüstbau', regex: 'Gerüstbau|Geruestbau|Gerüstverleih' },
  { id: 'dachdecker', label: 'Dachdecker & Bedachung', regex: 'Dachdecker|Bedachung|Dachtechnik|Flachdach' },
  { id: 'elektrotechnik', label: 'Elektrotechnik & PV', regex: 'Elektrotechnik|Elektroinstallation|Photovoltaik|Solartechnik' },
  { id: 'kaelteklima', label: 'Kälte- & Klimatechnik', regex: 'Kältetechnik|Kaeltetechnik|Klimatechnik|Klimaanlagen' },
  { id: 'aufzug', label: 'Aufzug- & Tortechnik', regex: 'Aufzugstechnik|Torantriebe|Garagentor|Tortechnik' },
  { id: 'brandschutz', label: 'Brandschutz & Sicherheitstechnik', regex: 'Brandschutz|Sicherheitstechnik|Alarmanlagen|Schließanlagen|Schliessanlagen' },
];

/**
 * Bundesland-Abfrage über den amtlichen ISO-Code – deckt NRW vollständig ab.
 *
 * `pflicht` sagt, welches Merkmal dransteht muss. Für die E-Mail-Strecke ist das
 * die Website (von dort wird die Adresse gelesen), für die Anrufliste die
 * Telefonnummer. Beides zugleich zu verlangen halbiert die Treffer, ohne dass
 * es jemandem hilft: Zum Anrufen braucht man keine Website.
 */
function buildRegionQuery(craft: string, isoRegion: string, pflicht: 'website' | 'telefon' | 'keine'): string {
  const keys = pflicht === 'website' ? ['website', 'contact:website']
    : pflicht === 'telefon' ? ['phone', 'contact:phone', 'contact:mobile']
    : [''];
  const zeilen = keys.map(k => `  nwr["craft"="${craft}"]${k ? `["${k}"]` : ''}(area.r);`).join('\n');
  return `[out:json][timeout:180];
area["ISO3166-2"="${isoRegion}"][admin_level=4]->.r;
(
${zeilen}
);
out center tags;`;
}

/**
 * Namenssuche für Gewerke ohne eigenes OSM-Tag (Abbruch, Umzug, Reinigung …).
 *
 * Die Regex läuft über alle benannten Objekte des Bundeslands – das ist nur
 * tragbar, weil zusätzlich eine Telefonnummer verlangt wird. Overpass kann die
 * Nummer als Index nutzen und muss nicht jeden Namen in NRW anfassen.
 */
function buildNameQuery(regex: string, isoRegion: string): string {
  const keys = ['phone', 'contact:phone', 'contact:mobile'];
  const zeilen = keys
    .map(k => `  nwr["name"~"${regex}",i]["${k}"](area.r);`)
    .join('\n');
  return `[out:json][timeout:180];
area["ISO3166-2"="${isoRegion}"][admin_level=4]->.r;
(
${zeilen}
);
out center tags;`;
}

export interface HandwerkProgress {
  laeuft: boolean;
  gewerk: string;
  erledigt: number;
  gesamt: number;
  gefunden: number;
  neu: number;
  mitWebsite: number;
  mitTelefon: number;
  fehler: string[];
  gestartet?: string;
  fertig?: string;
}

const fortschritt: HandwerkProgress = {
  laeuft: false, gewerk: '', erledigt: 0, gesamt: 0,
  gefunden: 0, neu: 0, mitWebsite: 0, mitTelefon: 0, fehler: [],
};

export function handwerkProgress(): HandwerkProgress {
  return { ...fortschritt, fehler: fortschritt.fehler.slice(-5) };
}

/**
 * Holt Handwerksbetriebe einer Region und legt sie als Leads an.
 * Läuft im Hintergrund weiter – der Aufrufer bekommt sofort eine Antwort und
 * fragt den Fortschritt ab. Ein HTTP-Request würde bei 20 Gewerken timeouten.
 */
export async function scrapeHandwerkRegion(opts: {
  isoRegion?: string;
  onlyWithWebsite?: boolean;
  /** Anrufliste statt E-Mail-Strecke: Telefonnummer ist Pflicht, Website egal. */
  nurMitTelefon?: boolean;
  /** Auch die Gewerke ohne OSM-Tag über den Firmennamen suchen (Abbruch, Umzug …). */
  mitNamenssuche?: boolean;
  track?: string;
} = {}): Promise<HandwerkProgress> {
  const isoRegion = opts.isoRegion || 'DE-NW';
  const nurMitTelefon = opts.nurMitTelefon === true;
  // Im Telefon-Modus ist die Website kein Kriterium mehr: Wer angerufen werden
  // soll, braucht eine Nummer, keine Homepage. Vorher fiel damit die Mehrheit
  // der Betriebe raus – OSM kennt viele Handwerker mit Telefon und ohne Website.
  const pflicht: 'website' | 'telefon' | 'keine' = nurMitTelefon
    ? 'telefon'
    : (opts.onlyWithWebsite !== false ? 'website' : 'keine');
  const track = opts.track || 'voice_agent';
  const mitNamenssuche = opts.mitNamenssuche !== false;

  if (fortschritt.laeuft) return handwerkProgress();
  const namensGewerke = mitNamenssuche ? NAME_GEWERKE : [];
  Object.assign(fortschritt, {
    laeuft: true, gewerk: '', erledigt: 0,
    gesamt: HANDWERK_CRAFTS.length + namensGewerke.length,
    gefunden: 0, neu: 0, mitWebsite: 0, mitTelefon: 0, fehler: [],
    gestartet: new Date().toISOString(), fertig: undefined,
  });

  // Ein Treffer wird genau gleich verarbeitet, egal ob er über craft= oder über
  // den Namen kam – darum eine Funktion für beides.
  const verarbeite = (el: OverpassElement, label: string) => {
    const t = el.tags ?? {};
    const name = t.name || t['operator'] || '';
    if (!name) return;
    const website = t.website || t['contact:website'];
    const telefon = t.phone || t['contact:phone'] || t['contact:mobile'] || undefined;
    if (pflicht === 'website' && !website) return;
    if (pflicht === 'telefon' && !telefon) return;
    fortschritt.gefunden++;
    const { inserted } = upsertLead({
      maps_place_id: `osm:${el.type}/${el.id}`,
      name,
      branche: label,
      stadt: t['addr:city'] || 'NRW',
      adresse: buildAddress(t),
      telefon,
      website,
      email: t.email || t['contact:email'] || undefined,
      hat_website: website ? 1 : 0,
      track,
      bester_kanal: telefon && !website ? 'telefon' : 'email',
      kontakt_hinweis: website
        ? 'Aus OpenStreetMap – E-Mail wird von der Website gelesen'
        : 'Aus OpenStreetMap – nur Telefon, kein Web-Kontakt',
      source_url: `https://www.openstreetmap.org/${el.type}/${el.id}`,
    } as Parameters<typeof upsertLead>[0]);
    if (inserted) fortschritt.neu++;
    if (website) fortschritt.mitWebsite++;
    if (telefon) fortschritt.mitTelefon++;
  };

  for (const gewerk of HANDWERK_CRAFTS) {
    fortschritt.gewerk = gewerk.label;
    try {
      const elements = await runOverpass(buildRegionQuery(gewerk.craft, isoRegion, pflicht));
      for (const el of elements) verarbeite(el, gewerk.label);
    } catch (err) {
      fortschritt.fehler.push(`${gewerk.label}: ${err instanceof Error ? err.message : String(err)}`);
    }
    fortschritt.erledigt++;
    await sleep(2500); // Gratis-Dienst nicht überfahren
  }

  // Danach die Gewerke, die OSM nicht als craft kennt. Die Namenssuche verlangt
  // immer eine Telefonnummer – ohne sie wäre die Abfrage über ganz NRW zu teuer.
  for (const gewerk of namensGewerke) {
    fortschritt.gewerk = gewerk.label;
    try {
      const elements = await runOverpass(buildNameQuery(gewerk.regex, isoRegion));
      for (const el of elements) verarbeite(el, gewerk.label);
    } catch (err) {
      fortschritt.fehler.push(`${gewerk.label}: ${err instanceof Error ? err.message : String(err)}`);
    }
    fortschritt.erledigt++;
    await sleep(2500);
  }

  fortschritt.laeuft = false;
  fortschritt.gewerk = '';
  fortschritt.fertig = new Date().toISOString();
  console.log(`[osm-handwerk] fertig: ${fortschritt.gefunden} gefunden, ${fortschritt.neu} neu, ${fortschritt.mitWebsite} mit Website`);
  return handwerkProgress();
}
