import { Resolver } from 'node:dns/promises';
import { get } from 'node:https';
import { domainToASCII } from 'node:url';
import { extractGeschaeftsfuehrer } from '../analyzer/website-checker';

export interface AddressCheck {
  email: string;
  status: 'invalid' | 'plausible' | 'unknown';
  label: string;
  detail: string;
  checkedAt: string;
  mailboxConfirmed: false;
}

export function normalizeAddress(raw: string): string | null {
  const parts = raw.trim().split('@');
  if (parts.length !== 2) return null;
  const [local, rawDomain] = parts;
  const domain = domainToASCII(rawDomain.toLowerCase());
  if (!local || local.length > 64 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local)
    || local.startsWith('.') || local.endsWith('.') || local.includes('..')
    || !domain.includes('.') || domain.length > 253
    || domain.split('.').some(p => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(p))) return null;
  const email = `${local.toLowerCase()}@${domain}`;
  return email.length <= 254 ? email : null;
}

export async function checkAddress(raw: string): Promise<AddressCheck> {
  const email = normalizeAddress(raw);
  const base = { email: email || raw.trim(), checkedAt: new Date().toISOString(), mailboxConfirmed: false as const };
  if (!email) return { ...base, status: 'invalid', label: 'Format ungueltig', detail: 'Die Adresse hat kein unterstuetztes E-Mail-Format.' };
  const resolver = new Resolver({ timeout: 2500, tries: 1 });
  try {
    const mx = await resolver.resolveMx(email.split('@')[1]);
    if (mx.some(r => r.exchange && r.exchange !== '.')) {
      return { ...base, status: 'plausible', label: 'Mail-Domain erreichbar', detail: 'Mailserver vorhanden. Existenz des Postfachs und Zuordnung zur Person sind nicht bestaetigt.' };
    }
    return { ...base, status: 'invalid', label: 'Domain nimmt keine E-Mails an', detail: 'Die Domain hat einen Null-MX-Eintrag.' };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOTFOUND') return { ...base, status: 'invalid', label: 'Domain nicht gefunden', detail: 'Die Domain der Adresse existiert laut DNS nicht.' };
    if (code === 'ENODATA') {
      try {
        const domain = email.split('@')[1];
        const results = await Promise.allSettled([resolver.resolve4(domain), resolver.resolve6(domain)]);
        if (results.some(r => r.status === 'fulfilled' && r.value.length)) {
          return { ...base, status: 'unknown', label: 'Kein eigener Mailserver-Eintrag', detail: 'Domain vorhanden; ein Mailserver-Fallback ist moeglich. Postfach nicht bestaetigt.' };
        }
      } catch { /* DNS may be temporarily unavailable. */ }
    }
    return { ...base, status: 'unknown', label: 'Pruefung unklar', detail: 'Kein verlaessliches DNS-Ergebnis. Das beweist keine ungueltige Adresse.' };
  } finally { resolver.cancel(); }
}

function nameParts(name: string): string[] {
  return name.replace(/\b(herr|frau|dr|prof)\.?(?=\s|$)\s*/gi, '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '').trim().split(/\s+/)
    .filter(Boolean);
}

export function addressCandidates(name: string, domain: string): string[] {
  const p = nameParts(name);
  if (p.length < 2 || p.length > 4 || p.some(x => !/^[a-z][a-z'-]+$/.test(x))) return [];
  const first = p[0].replace(/'/g, '');
  const last = p[p.length - 1].replace(/'/g, '');
  return [...new Set([`${first}.${last}`, `${first[0]}.${last}`, `${first}${last}`, `${first[0]}${last}`, last]
    .map(local => normalizeAddress(`${local}@${domain}`)).filter((e): e is string => !!e))];
}

export function publicIpv4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = p;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254
    || a === 172 && b >= 16 && b <= 31 || a === 192 && [0, 168].includes(b)
    || a === 100 && b >= 64 && b <= 127 || a === 198 && [18, 19, 51].includes(b)
    || a === 203 && b === 0);
}

// Pin the validated public address so DNS rebinding and redirects cannot reach internal services.
async function publicPage(url: URL, redirects = 0): Promise<{ html: string; url: string }> {
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443') throw Error('Nur oeffentliche HTTPS-Websites werden geprueft.');
  const resolver = new Resolver({ timeout: 2500, tries: 1 });
  let addresses: string[];
  try { addresses = await resolver.resolve4(url.hostname); } finally { resolver.cancel(); }
  if (!addresses.length || addresses.some(ip => !publicIpv4(ip))) throw Error('Keine oeffentliche Website-Adresse.');
  return new Promise((resolve, reject) => {
    const request = get(url, {
      headers: { 'user-agent': 'Tawano-ContactCheck/1.0', accept: 'text/html' },
      lookup: (_host, _opts, cb) => cb(null, addresses[0], 4),
    }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode || 0) && response.headers.location) {
        response.resume();
        let next: URL;
        try { next = new URL(response.headers.location, url); } catch { reject(Error('Ungueltige Weiterleitung.')); return; }
        if (redirects >= 2 || next.hostname.replace(/^www\./, '') !== url.hostname.replace(/^www\./, '')) return reject(Error('Weiterleitung auf andere Domain.'));
        publicPage(next, redirects + 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200 || !/text\/html|application\/xhtml/i.test(response.headers['content-type'] || '')) {
        response.resume(); reject(Error('Website nicht lesbar.')); return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) request.destroy(Error('Website zu gross.'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve({ html: Buffer.concat(chunks).toString('utf8'), url: url.href }));
    });
    const timer = setTimeout(() => request.destroy(Error('Website-Zeitlimit erreicht.')), 7000);
    request.on('close', () => clearTimeout(timer));
    request.on('error', reject);
  });
}

export interface ContactCandidate {
  email: string;
  origin: 'public' | 'suggested' | 'stored';
  source: string | null;
  nameMatch: boolean;
}

export async function discoverContact(lead: { website?: string; email?: string; geschaeftsfuehrer?: string }, nameOverride?: string) {
  let name = nameOverride?.trim() || lead.geschaeftsfuehrer || '';
  let nameSource: string | null = null;
  let domain = '';
  const candidates = new Map<string, ContactCandidate>();
  const notices: string[] = [];
  const stored = normalizeAddress(lead.email || '');
  if (stored) candidates.set(stored, { email: stored, origin: 'stored', source: null, nameMatch: false });
  const pages: Array<{ html: string; url: string }> = [];
  if (lead.website) {
    try {
      const url = new URL(/^https?:\/\//i.test(lead.website) ? lead.website : `https://${lead.website}`);
      url.protocol = 'https:';
      domain = url.hostname.replace(/^www\./, '');
      const home = await publicPage(url);
      pages.push(home);
      const links = [...home.html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map(m => m[1]);
      const targets = new Set<string>();
      for (const path of [...links.filter(p => /impressum|kontakt|team|ueber-uns|about/i.test(p)), '/impressum', '/kontakt']) {
        try {
          const next = new URL(path, home.url);
          if (next.origin === new URL(home.url).origin) { next.hash = ''; targets.add(next.href); }
        } catch { /* Ignore malformed links. */ }
        if (targets.size >= 3) break;
      }
      const results = await Promise.allSettled([...targets].map(u => publicPage(new URL(u))));
      for (const r of results) if (r.status === 'fulfilled') pages.push(r.value);
      if (results.some(r => r.status === 'rejected')) notices.push('Einige Unterseiten waren nicht lesbar.');
    } catch { notices.push('Website nicht lesbar; keine oeffentliche Adresse bestaetigt.'); }
  } else notices.push('Keine Firmenwebsite gespeichert.');
  if (!name) {
    for (const page of pages) {
      const found = extractGeschaeftsfuehrer(page.html);
      if (found) { name = found; nameSource = page.url; break; }
    }
  }
  if (!domain && stored) {
    const storedDomain = stored.split('@')[1];
    if (!/^(gmail\.com|googlemail\.com|gmx\.(de|net|com)|web\.de|outlook\.(de|com)|hotmail\.(de|com)|yahoo\.(de|com)|icloud\.com|t-online\.de|aol\.com|proton\.(me|com))$/.test(storedDomain)) domain = storedDomain;
  }
  const expected = new Set(domain ? addressCandidates(name, domain) : []);
  for (const page of pages) {
    const clean = page.html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/&#64;|&commat;/gi, '@');
    for (const match of clean.matchAll(/[a-z0-9._%+\-]+@[a-z0-9.-]+\.[a-z]{2,63}/gi)) {
      const email = normalizeAddress(match[0]);
      if (!email || email.split('@')[1] !== domain) continue;
      candidates.set(email, { email, origin: 'public', source: page.url, nameMatch: expected.has(email) });
    }
  }
  for (const email of expected) if (!candidates.has(email)) candidates.set(email, { email, origin: 'suggested', source: null, nameMatch: true });
  if (!name) notices.push('Geschaeftsfuehrer nicht gefunden. Name kann manuell ergaenzt werden.');
  return { name, nameSource, domain, checkedAt: new Date().toISOString(), notices,
    candidates: [...candidates.values()].sort((a, b) => Number(b.origin === 'public' && b.nameMatch) - Number(a.origin === 'public' && a.nameMatch)).slice(0, 20) };
}
