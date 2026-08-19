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
  { craft: 'electrician', label: 'Elektriker' },
  { craft: 'plumber', label: 'Sanitär' },
  { craft: 'hvac', label: 'Heizung & Klima' },
  { craft: 'carpenter', label: 'Zimmerei' },
  { craft: 'joiner', label: 'Schreinerei' },
  { craft: 'roofer', label: 'Dachdecker' },
  { craft: 'painter', label: 'Maler' },
  { craft: 'plasterer', label: 'Stuckateur' },
  { craft: 'tiler', label: 'Fliesenleger' },
  { craft: 'locksmith', label: 'Schlüsseldienst' },
  { craft: 'metal_construction', label: 'Metallbau' },
  { craft: 'glaziery', label: 'Glaserei' },
  { craft: 'window_construction', label: 'Fensterbau' },
  { craft: 'gardener', label: 'Garten- & Landschaftsbau' },
  { craft: 'stonemason', label: 'Steinmetz' },
  { craft: 'scaffolder', label: 'Gerüstbau' },
  { craft: 'floorer', label: 'Bodenleger' },
  { craft: 'insulation', label: 'Dämmung' },
  { craft: 'chimney_sweeper', label: 'Schornsteinfeger' },
  { craft: 'sawmill', label: 'Holzbau' },
];

/** Bundesland-Abfrage über den amtlichen ISO-Code – deckt NRW vollständig ab. */
function buildRegionQuery(craft: string, isoRegion: string, onlyWithWebsite: boolean): string {
  const extra = onlyWithWebsite ? '["website"]' : '';
  const extra2 = onlyWithWebsite ? '["contact:website"]' : '';
  return `[out:json][timeout:180];
area["ISO3166-2"="${isoRegion}"][admin_level=4]->.r;
(
  nwr["craft"="${craft}"]${extra}(area.r);
${onlyWithWebsite ? `  nwr["craft"="${craft}"]${extra2}(area.r);` : ''}
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
  track?: string;
} = {}): Promise<HandwerkProgress> {
  const isoRegion = opts.isoRegion || 'DE-NW';
  const onlyWithWebsite = opts.onlyWithWebsite !== false;
  const track = opts.track || 'voice_agent';

  if (fortschritt.laeuft) return handwerkProgress();
  Object.assign(fortschritt, {
    laeuft: true, gewerk: '', erledigt: 0, gesamt: HANDWERK_CRAFTS.length,
    gefunden: 0, neu: 0, mitWebsite: 0, mitTelefon: 0, fehler: [],
    gestartet: new Date().toISOString(), fertig: undefined,
  });

  for (const gewerk of HANDWERK_CRAFTS) {
    fortschritt.gewerk = gewerk.label;
    try {
      const elements = await runOverpass(buildRegionQuery(gewerk.craft, isoRegion, onlyWithWebsite));
      for (const el of elements) {
        const t = el.tags ?? {};
        const name = t.name || t['operator'] || '';
        if (!name) continue;
        const website = t.website || t['contact:website'];
        if (onlyWithWebsite && !website) continue;
        fortschritt.gefunden++;
        const { inserted } = upsertLead({
          maps_place_id: `osm:${el.type}/${el.id}`,
          name,
          branche: gewerk.label,
          stadt: t['addr:city'] || 'NRW',
          adresse: buildAddress(t),
          telefon: t.phone || t['contact:phone'] || t['contact:mobile'] || undefined,
          website,
          email: t.email || t['contact:email'] || undefined,
          hat_website: website ? 1 : 0,
          track,
          bester_kanal: 'email',
          kontakt_hinweis: 'Aus OpenStreetMap – E-Mail wird von der Website gelesen',
          source_url: `https://www.openstreetmap.org/${el.type}/${el.id}`,
        } as Parameters<typeof upsertLead>[0]);
        if (inserted) fortschritt.neu++;
        if (website) fortschritt.mitWebsite++;
        if (t.phone || t['contact:phone']) fortschritt.mitTelefon++;
      }
    } catch (err) {
      fortschritt.fehler.push(`${gewerk.label}: ${err instanceof Error ? err.message : String(err)}`);
    }
    fortschritt.erledigt++;
    await sleep(2500); // Gratis-Dienst nicht überfahren
  }

  fortschritt.laeuft = false;
  fortschritt.gewerk = '';
  fortschritt.fertig = new Date().toISOString();
  console.log(`[osm-handwerk] fertig: ${fortschritt.gefunden} gefunden, ${fortschritt.neu} neu, ${fortschritt.mitWebsite} mit Website`);
  return handwerkProgress();
}
