import { ScrapeInput } from '../types';

export interface RawLead {
  maps_place_id: string;
  name: string;
  adresse?: string;
  telefon?: string;
  website?: string;
  google_bewertung?: number;
  google_anzahl_reviews?: number;
  google_oeffnungszeiten?: string;
  google_foto_url?: string;
  source_url: string;
  branche: string;
  stadt: string;
  stadtbezirk?: string;
}

export async function scrapeGoogleMaps(input: ScrapeInput): Promise<RawLead[]> {
  const apifyToken = process.env.APIFY_API_TOKEN;
  const serpApiKey = process.env.SERPAPI_KEY;

  if (apifyToken) {
    return scrapeViaApify(input, apifyToken);
  } else if (serpApiKey) {
    return scrapeViaSerpApi(input, serpApiKey);
  } else {
    throw new Error('Kein Scraper konfiguriert. Setze APIFY_API_TOKEN in .env');
  }
}

async function scrapeViaApify(input: ScrapeInput, token: string): Promise<RawLead[]> {
  const actorId = process.env.APIFY_GOOGLE_MAPS_ACTOR ?? 'compass/crawler-google-places';
  const searchTerm = input.branche;
  const locationQuery = buildLocation(input);
  const maxResults = input.maxResults ?? 50;

  console.log(`  [Apify] Starte Suche: "${searchTerm}" in "${locationQuery}" (max ${maxResults})`);

  const runRes = await fetch(`https://api.apify.com/v2/acts/${actorId.replace('/', '~')}/runs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      searchStringsArray: [searchTerm],
      locationQuery,
      maxCrawledPlacesPerSearch: maxResults,
      language: 'de',
      countryCode: 'de',
      scrapeReviews: false,
      scrapeImages: false,
      maximumLeadsEnrichmentRecords: 0,
      scrapeSocialMediaProfiles: {
        facebooks: false,
        instagrams: false,
        youtubes: false,
        tiktoks: false,
        twitters: false,
      },
    }),
  });

  if (!runRes.ok) {
    const err = await runRes.text();
    throw new Error(`Apify run failed: ${runRes.status} — ${err}`);
  }

  const run = await runRes.json() as { data: { id: string } };
  const runId = run.data.id;
  console.log(`  [Apify] Run gestartet: ${runId}`);

  const items = await waitForApifyRun(runId, token);
  console.log(`  [Apify] ${items.length} Ergebnisse`);
  return mapApifyItems(items, input);
}

async function waitForApifyRun(runId: string, token: string, maxWaitMs = 180_000): Promise<unknown[]> {
  const start = Date.now();
  let dots = 0;
  process.stdout.write('  [Apify] Warte auf Ergebnisse');

  while (Date.now() - start < maxWaitMs) {
    await sleep(5000);
    process.stdout.write('.');
    dots++;

    const statusRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const status = await statusRes.json() as { data: { status: string; defaultDatasetId: string } };

    if (status.data.status === 'SUCCEEDED') {
      process.stdout.write('\n');
      const dataRes = await fetch(
        `https://api.apify.com/v2/datasets/${status.data.defaultDatasetId}/items?format=json`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      return dataRes.json() as Promise<unknown[]>;
    }

    if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(status.data.status)) {
      process.stdout.write('\n');
      throw new Error(`Apify run ${status.data.status}`);
    }
  }
  process.stdout.write('\n');
  throw new Error(`Apify run Timeout nach ${maxWaitMs / 1000}s`);
}

function mapApifyItems(items: unknown[], input: ScrapeInput): RawLead[] {
  return (items as Record<string, unknown>[])
    .filter(item => item.placeId && item.title)
    .map(item => ({
      maps_place_id: String(item.placeId),
      name: String(item.title),
      adresse: item.address ? String(item.address) : undefined,
      telefon: item.phone ? String(item.phone) : undefined,
      website: item.website ? String(item.website) : undefined,
      google_bewertung: item.totalScore ? Number(item.totalScore) : undefined,
      google_anzahl_reviews: item.reviewsCount ? Number(item.reviewsCount) : undefined,
      google_oeffnungszeiten: item.openingHours ? JSON.stringify(item.openingHours) : undefined,
      google_foto_url: item.imageUrl ? String(item.imageUrl) : undefined,
      source_url: item.url ? String(item.url) : `https://maps.google.com/?cid=${item.placeId}`,
      branche: input.branche,
      stadt: input.stadt,
      stadtbezirk: input.stadtbezirk,
    }));
}

async function scrapeViaSerpApi(input: ScrapeInput, key: string): Promise<RawLead[]> {
  const query = buildQuery(input);
  const url = `https://serpapi.com/search.json?engine=google_maps&q=${encodeURIComponent(query)}&api_key=${key}&hl=de&gl=de`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`SerpApi error: ${res.status}`);

  const data = await res.json() as { local_results?: Record<string, unknown>[] };
  const results = data.local_results ?? [];

  return results
    .filter(r => r.place_id && r.title)
    .slice(0, input.maxResults ?? 50)
    .map(r => ({
      maps_place_id: String(r.place_id),
      name: String(r.title),
      adresse: r.address ? String(r.address) : undefined,
      telefon: r.phone ? String(r.phone) : undefined,
      website: r.website ? String(r.website) : undefined,
      google_bewertung: r.rating ? Number(r.rating) : undefined,
      google_anzahl_reviews: r.reviews ? Number(r.reviews) : undefined,
      source_url: r.link ? String(r.link) : `https://maps.google.com`,
      branche: input.branche,
      stadt: input.stadt,
      stadtbezirk: input.stadtbezirk,
    }));
}

function buildQuery(input: ScrapeInput): string {
  const ort = [input.stadtbezirk, input.stadt].filter(Boolean).join(' ');
  return `${input.branche} ${ort}`;
}

function buildLocation(input: ScrapeInput): string {
  return [input.stadtbezirk, input.stadt, 'Deutschland'].filter(Boolean).join(', ');
}

function sleep(ms: number) {
  return new Promise(res => setTimeout(res, ms));
}
