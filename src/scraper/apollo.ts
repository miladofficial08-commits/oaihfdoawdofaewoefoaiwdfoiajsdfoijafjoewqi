// Apollo.io als zusätzliche Lead-Quelle neben Google Maps.
//
// Strategie (siehe Gespräch): Wir verkaufen KI-Voice-Agents / KI-Rezeptionisten.
// Das stärkste Kaufsignal ist eine Firma, die GERADE eine Rezeptions-/Empfangskraft
// SUCHT. Apollos Company-Search kann genau danach filtern
// (`q_organization_job_titles` + `organization_num_jobs_range`) und liefert pro
// Suche `pagination.total_entries` — d.h. wir sehen die Segmentgröße, OHNE Credits
// pro Lead zu verbrennen (1 Credit / Seite). So finden wir datenbasiert heraus,
// welches Segment (Zahnärzte / Anwälte / Handwerk / Agenturen) in DACH am meisten
// erreichbare, aktiv suchende Firmen hat — darauf fokussieren wir dann.

import { upsertLead } from '../db/leads-repo';

const APOLLO_BASE = 'https://api.apollo.io/api/v1';

function apolloKey(): string {
  const key = process.env.APOLLO_API_KEY?.trim();
  if (!key) {
    throw new Error(
      'APOLLO_API_KEY fehlt. Trage ihn in die .env-Datei ein (Apollo → Settings → Integrations → API).'
    );
  }
  return key;
}

async function apolloPost(path: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${APOLLO_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      accept: 'application/json',
      'x-api-key': apolloKey(),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Apollo ${path} → ${res.status}: ${text.slice(0, 400)}`);
  }
  return res.json();
}

// ── Job-Titel, die "Firma braucht jemanden am Empfang/Telefon" signalisieren ──
// DE + EN Varianten, damit DACH-Firmen mit deutsch- oder englischsprachigen
// Ausschreibungen beide getroffen werden.
const RECEPTION_JOB_TITLES = [
  'Rezeptionist',
  'Rezeptionistin',
  'Empfang',
  'Empfangsmitarbeiter',
  'Empfangskraft',
  'Receptionist',
  'Front Desk',
  'Front Office',
  'Office Manager',
  'Büromitarbeiter',
  'Telefonist',
  'Kundenservice',
];

export interface Segment {
  id: string;
  /** Branche-Label, wie es in der leads-Tabelle landen soll. */
  label: string;
  /** Apollo `q_organization_keyword_tags` — grenzt die Branche ein. */
  keywords: string[];
}

// DACH-Segmente für die Discovery. Job-Titel-Signal ist bewusst über alle gleich
// (jede dieser Branchen braucht Empfang/Telefon); es variiert nur die Branche.
export const DACH_SEGMENTS: Segment[] = [
  {
    id: 'zahnaerzte',
    label: 'Zahnärzte / Praxen',
    keywords: ['dental', 'zahnarzt', 'dental practice', 'medical practice', 'arztpraxis', 'healthcare'],
  },
  {
    id: 'anwaelte',
    label: 'Anwälte / Kanzleien',
    keywords: ['law practice', 'legal services', 'kanzlei', 'rechtsanwalt', 'steuerberater', 'tax'],
  },
  {
    id: 'handwerk',
    label: 'Handwerk',
    keywords: ['construction', 'plumbing', 'electrical', 'hvac', 'handwerk', 'sanitär', 'elektro'],
  },
  {
    id: 'agenturen',
    label: 'Agenturen / KMU',
    keywords: ['marketing', 'advertising', 'consulting', 'agency', 'werbeagentur', 'dienstleistung'],
  },
];

export const DACH_LOCATIONS = ['Germany', 'Austria', 'Switzerland'];

interface ApolloOrg {
  id: string;
  name?: string;
  website_url?: string;
  primary_domain?: string;
  linkedin_url?: string;
  phone?: string;
  primary_phone?: { number?: string };
  industry?: string;
  estimated_num_employees?: number;
  city?: string;
  state?: string;
  country?: string;
}

interface OrgSearchResult {
  organizations: ApolloOrg[];
  total: number;
}

/**
 * Eine Seite der Company-Search. Nutzt das Job-Posting-Signal (aktiv suchende Firmen).
 * `per_page: 1` genügt, um `total_entries` (Segmentgröße) zu lesen, ohne Sample zu ziehen.
 */
export async function apolloOrgSearch(opts: {
  keywords: string[];
  locations?: string[];
  jobTitles?: string[];
  minJobs?: number;
  page?: number;
  perPage?: number;
}): Promise<OrgSearchResult> {
  const body: Record<string, unknown> = {
    q_organization_keyword_tags: opts.keywords,
    organization_locations: opts.locations ?? DACH_LOCATIONS,
    q_organization_job_titles: opts.jobTitles ?? RECEPTION_JOB_TITLES,
    organization_job_locations: opts.locations ?? DACH_LOCATIONS,
    organization_num_jobs_range: { min: opts.minJobs ?? 1 },
    page: opts.page ?? 1,
    per_page: opts.perPage ?? 25,
  };
  const data = await apolloPost('/mixed_companies/search', body);
  return {
    organizations: (data.organizations ?? data.accounts ?? []) as ApolloOrg[],
    total: data.pagination?.total_entries ?? 0,
  };
}

function orgToLead(org: ApolloOrg, brancheLabel: string) {
  const stadt = org.city || org.state || org.country || 'DACH';
  const website = org.website_url || (org.primary_domain ? `https://${org.primary_domain}` : undefined);
  const telefon = org.primary_phone?.number || org.phone || undefined;
  return {
    maps_place_id: `apollo:${org.id}`, // eigener Namespace → greift in bestehende Dedup
    name: org.name || 'Unbekannt',
    branche: brancheLabel,
    stadt,
    adresse: [org.city, org.state, org.country].filter(Boolean).join(', ') || undefined,
    telefon,
    website,
    website_domain: org.primary_domain || undefined,
    linkedin_url: org.linkedin_url || undefined,
    track: 'consult',
    source_url: org.linkedin_url || website,
  };
}

export interface SegmentReportRow {
  id: string;
  label: string;
  totalHiring: number; // Firmen in DACH, die aktiv Empfang/Rezeption suchen
  sampled: number;     // wie viele Leads wir tatsächlich als Sample geholt haben
  inserted: number;    // davon neu in der DB
  withPhone: number;
  withWebsite: number;
  error?: string;
}

/**
 * Läuft alle Segmente ab: liest die Segmentgröße (total_entries) und zieht ein
 * kleines Sample echter Firmen in die leads-Tabelle. So bekommt der Nutzer einen
 * Vergleich, welches Segment am meisten aktiv-suchende Firmen hat — der Gewinner
 * wird danach separat mit Entscheider + E-Mail angereichert.
 */
export async function discoverSegments(opts: {
  segments?: Segment[];
  locations?: string[];
  samplePerSegment?: number;
} = {}): Promise<SegmentReportRow[]> {
  const segments = opts.segments ?? DACH_SEGMENTS;
  const locations = opts.locations ?? DACH_LOCATIONS;
  const sampleSize = opts.samplePerSegment ?? 25;
  const rows: SegmentReportRow[] = [];

  for (const seg of segments) {
    const row: SegmentReportRow = {
      id: seg.id, label: seg.label, totalHiring: 0, sampled: 0, inserted: 0, withPhone: 0, withWebsite: 0,
    };
    try {
      const perPage = Math.min(sampleSize, 100);
      const res = await apolloOrgSearch({ keywords: seg.keywords, locations, perPage, page: 1 });
      row.totalHiring = res.total;
      for (const org of res.organizations.slice(0, sampleSize)) {
        const leadData = orgToLead(org, seg.label);
        const { inserted } = upsertLead(leadData);
        row.sampled++;
        if (inserted) row.inserted++;
        if (leadData.telefon) row.withPhone++;
        if (leadData.website) row.withWebsite++;
      }
      console.log(`  ${seg.label}: ${res.total} suchende Firmen (Sample ${row.sampled}, ${row.inserted} neu)`);
    } catch (err) {
      row.error = err instanceof Error ? err.message : String(err);
      console.log(`  ${seg.label}: FEHLER – ${row.error}`);
    }
    rows.push(row);
  }
  return rows;
}
