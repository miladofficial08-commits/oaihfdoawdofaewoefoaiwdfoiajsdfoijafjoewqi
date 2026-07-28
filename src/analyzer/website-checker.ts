import { SocialKanal, WebsiteAnalysis } from '../types';

const CHATBOT_KEYWORDS = [
  'tidio', 'tawk.to', 'tawkto', 'intercom', 'drift.com',
  'crisp.chat', 'zendesk', 'livechat', 'freshchat', 'hubspot',
  'chat-widget', 'chatbot', 'userlike', 'smartsupp',
];

const WHATSAPP_PATTERNS = [
  /wa\.me\//i,
  /whatsapp\.com\/send/i,
  /api\.whatsapp\.com/i,
];

const BOOKING_PATTERNS = [
  /calendly\.com/i, /cal\.com/i, /doctolib/i, /treatwell/i,
  /booksy/i, /timify/i, /appointy/i, /simplybook/i,
  /termine-online/i, /terminland/i, /eTermin/i,
  /termin-jetzt/i, /buchung/i, /online.?termin/i,
];

const FAQ_KEYWORDS = ['häufige fragen', 'faq', 'fragen & antworten', 'fragen und antworten'];
const NOTDIENST_KEYWORDS = ['notdienst', 'notfall', '24h', '24/7', 'rund um die uhr', 'soforteinsatz', 'notruf'];
const OLD_SIGNALS = ['jquery-1.', 'jquery-2.', 'bootstrap-2.', 'bootstrap-3.', 'swf', '.swf"', '.swf\''];
const CTA_PATTERNS = [/kontakt/i, /anfrage/i, /termin/i, /angebot/i, /beratung/i, /rufen sie/i, /jetzt/i];
const SPAM_EMAIL_DOMAINS = ['example.com', 'sentry.io', 'w3.org', 'schema.org', 'google.com', 'facebook.com', 'apple.com'];
const ASSET_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'css', 'js', 'woff', 'woff2', 'ttf', 'ico'];
const GENERIC_SOCIAL_PATHS = new Set([
  '', 'about', 'accounts', 'business', 'channel', 'contact', 'dialog', 'events',
  'explore', 'groups', 'help', 'intent', 'marketplace', 'p', 'pages',
  'plugins', 'privacy', 'profile.php', 'reel', 'reels', 'share', 'share.php',
  'sharearticle', 'sharer', 'stories', 'tr', 'watch',
]);

export async function analyzeWebsite(url: string): Promise<WebsiteAnalysis> {
  if (!url) {
    return emptyResult('Keine URL');
  }

  const normalized = url.startsWith('http') ? url : `https://${url}`;

  try {
    const startedAt = Date.now();
    const page = await fetchPage(normalized);

    if (page.status && page.status >= 400) return emptyResult(`HTTP ${page.status}`);
    if (page.html == null) return emptyResult('Timeout');

    const analysis = analyzeHtml(page.html, normalized, Date.now() - startedAt, page.finalUrl);

    // Geschäftsführer steht praktisch immer im Impressum (§5 TMG: "vertreten durch …"),
    // selten auf der Startseite – daher zuerst Startseite, dann Impressum-Unterseiten.
    analysis.geschaeftsfuehrer = extractGeschaeftsfuehrer(page.html);

    // E-Mail-Nachfassen: Deutsche Firmen haben ihre E-Mail fast immer nur im Impressum
    // oder auf der Kontaktseite (Impressumspflicht §5 TMG), praktisch nie auf der Startseite.
    // Ohne diesen Schritt bleiben die meisten Leads ohne E-Mail und damit nicht anschreibbar.
    // Dieselben Unterseiten liefern auch den Geschäftsführer – daher in einem Durchgang.
    if (!analysis.email || !analysis.geschaeftsfuehrer) {
      const found = await scanContactPages(page.html, page.finalUrl, { needEmail: !analysis.email, needGf: !analysis.geschaeftsfuehrer });
      if (found.email && !analysis.email) {
        analysis.email = found.email.email;
        analysis.evidence?.push(`Oeffentliche E-Mail auf Unterseite gefunden: ${found.email.email} (${found.email.source})`);
      }
      if (found.geschaeftsfuehrer && !analysis.geschaeftsfuehrer) {
        analysis.geschaeftsfuehrer = found.geschaeftsfuehrer;
        analysis.evidence?.push(`Geschaeftsfuehrer im Impressum gefunden: ${found.geschaeftsfuehrer}`);
      }
    }

    return analysis;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return emptyResult(msg.includes('abort') ? 'Timeout' : msg.slice(0, 100));
  }
}

interface FetchedPage { html?: string; finalUrl: string; status?: number }

async function fetchPage(url: string): Promise<FetchedPage> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        'Accept-Language': 'de-DE,de;q=0.9',
      },
      redirect: 'follow',
    });
    const finalUrl = res.url || url;
    if (!res.ok) return { finalUrl, status: res.status };
    return { html: await res.text(), finalUrl, status: res.status };
  } finally {
    clearTimeout(timeout);
  }
}

// Folgt bis zu 3 Impressum-/Kontakt-Unterseiten (nur gleiche Domain) und sucht dort
// E-Mail und/oder Geschäftsführer – in EINEM Durchgang, um Doppel-Fetches zu vermeiden.
async function scanContactPages(
  homeHtml: string,
  base: string,
  need: { needEmail: boolean; needGf: boolean }
): Promise<{ email?: { email: string; source: string }; geschaeftsfuehrer?: string }> {
  const out: { email?: { email: string; source: string }; geschaeftsfuehrer?: string } = {};
  for (const u of candidateContactUrls(homeHtml, base).slice(0, 3)) {
    try {
      const page = await fetchPage(u);
      if (!page.html) continue;
      if (need.needEmail && !out.email) {
        const email = extractEmail(page.html);
        if (email) out.email = { email, source: u };
      }
      if (need.needGf && !out.geschaeftsfuehrer) {
        const gf = extractGeschaeftsfuehrer(page.html);
        if (gf) out.geschaeftsfuehrer = gf;
      }
      const emailDone = !need.needEmail || out.email;
      const gfDone = !need.needGf || out.geschaeftsfuehrer;
      if (emailDone && gfDone) break;
    } catch { /* Unterseite nicht erreichbar – ignorieren */ }
  }
  return out;
}

// Erkennt den Geschäftsführer/Inhaber aus dem (Impressum-)Text. Deutsche Impressen nutzen
// feste Formulierungen ("Geschäftsführer:", "Vertreten durch:", "Inhaber:").
const GF_LABELS = [
  'gesch[äa]ftsf[üu]hrer(?:in)?',
  'gesch[äa]ftsf[üu]hrung',
  'vertretungsberechtigt[a-zäöüß]*(?:\\s+gesch[äa]ftsf[üu]hrer(?:in)?)?',
  'vertreten durch',
  'inhaber(?:in)?',
];
// Optionale Titel/Anrede + 2–4 großgeschriebene Namensteile.
const NAME_PART = "[A-ZÄÖÜ][a-zäöüß]+(?:[-'][A-ZÄÖÜ][a-zäöüß]+)?";
const NAME_RE = "(?:Herr |Frau |Dr\\.? |Prof\\.? |Dipl\\.-?[A-Za-zäöüß]+\\.? )*" + NAME_PART + "(?:\\s+" + NAME_PART + "){1,3}";
// Wortgrenzen (\b) sind wichtig: sonst matcht z.B. "ust" (von USt) im Namen "Mustermann".
const GF_BLOCKWORDS = /\b(gmbh|kg|ohg|gbr|mbh|ug|ag|handelsregister|registergericht|amtsgericht|gericht|umsatzsteuer|steuernummer|steuer|ust|hrb|hra|impressum|telefon|telefax|fax|e-?mail|vertreten|gesch[äa]ftsf[üu]hr\w*|inhaber\w*|adresse|stra[sß]e|platz|allee|weg)\b/i;
const GF_TITLES = /^(Herr|Frau|Dr\.?|Prof\.?|Dipl\.?-?[A-Za-zäöüß]*\.?)$/i;
// Nur zum ABSCHNEIDEN nachlaufender Wörter (Berufe/Rechtsform) – NICHT zum Verwerfen,
// damit echte Nachnamen wie "Meister" erhalten bleiben.
const GF_TRAILING_NOISE = /^(installateur|meister|elektromeister|handwerksmeister|klempnermeister|heizungsbaumeister|ingenieur|techniker|monteur|inhaber|gesch[äa]ftsf[üu]hr\w*|gmbh|kg|ohg|gbr|mbh|ug|ag|handelsregister|registergericht|amtsgericht|ust|hrb|hra|steuernummer|telefon|telefax|fax|impressum|adresse)$/i;

export function extractGeschaeftsfuehrer(html: string): string | undefined {
  const text = stripTags(decodeHtmlEntities(html))
    .replace(/&auml;/g, 'ä').replace(/&ouml;/g, 'ö').replace(/&uuml;/g, 'ü').replace(/&szlig;/g, 'ß')
    .replace(/&Auml;/g, 'Ä').replace(/&Ouml;/g, 'Ö').replace(/&Uuml;/g, 'Ü')
    .replace(/\s+/g, ' ');
  for (const label of GF_LABELS) {
    const re = new RegExp(label + "\\s*[:\\-–—]?\\s*(" + NAME_RE + ")", 'i');
    const m = text.match(re);
    if (!m || !m[1]) continue;
    let words = m[1].trim().replace(/\s+/g, ' ').split(' ');
    // Nachlaufende Berufs-/Rechtsform-/Register-Wörter abschneiden (greedy-Match zieht z.B.
    // "… Installateur" oder "… Handelsregister" mit rein).
    while (words.length > 2 && GF_TRAILING_NOISE.test(words[words.length - 1])) words.pop();
    // Führende Titel/Anrede entfernen (Herr, Frau, Dr., Prof., Dipl.-Ing.).
    while (words.length > 2 && GF_TITLES.test(words[0])) words.shift();
    const name = words.join(' ');
    if (isPlausiblePersonName(name)) return name.slice(0, 60);
  }
  return undefined;
}

function isPlausiblePersonName(name: string): boolean {
  if (/\d/.test(name)) return false;
  if (GF_BLOCKWORDS.test(name)) return false;
  const words = name.split(/\s+/).filter(w => !GF_TITLES.test(w));
  return words.length >= 2 && words.length <= 4 && words.every(w => /^[A-ZÄÖÜ]/.test(w));
}

function candidateContactUrls(html: string, base: string): string[] {
  let baseHost: string;
  try { baseHost = new URL(base).hostname.replace(/^www\./, ''); } catch { return []; }

  const sameHost = (u: string): boolean => {
    try { return new URL(u).hostname.replace(/^www\./, '') === baseHost; } catch { return false; }
  };

  const out: string[] = [];
  const add = (u: string) => { if (sameHost(u) && !out.includes(u)) out.push(u); };

  // 1. Echte Impressum-/Kontakt-Links aus der Startseite (präziser als Rate-Pfade)
  const re = /href=["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const href = m[1];
    if (href.toLowerCase().startsWith('mailto:')) continue;
    if (!/impressum|imprint|kontakt|contact/i.test(href)) continue;
    try { add(new URL(href, base).toString()); } catch { /* ungültiger href */ }
  }
  // 2. Standard-Pfade als Fallback, falls kein Link im HTML steht
  for (const p of ['/impressum', '/impressum/', '/kontakt', '/kontakt/', '/contact', '/imprint']) {
    try { add(new URL(p, base).toString()); } catch { /* ignore */ }
  }
  return out;
}

export function analyzeHtml(html: string, url: string, durationMs = 0, finalUrl = url): WebsiteAnalysis {
  const lower = html.toLowerCase();
  const form = extractKontaktformular(html, finalUrl);
  const qualityFlags = collectQualityFlags(html, url, durationMs);
  const evidence = collectEvidence(html, finalUrl, form, qualityFlags);

  return {
    accessible: true,
    hat_chatbot: CHATBOT_KEYWORDS.some(k => lower.includes(k)),
    hat_whatsapp_link: WHATSAPP_PATTERNS.some(p => p.test(html)),
    hat_online_buchung: BOOKING_PATTERNS.some(p => p.test(html)),
    hat_faq: FAQ_KEYWORDS.some(k => lower.includes(k)),
    hat_notdienst_hinweis: NOTDIENST_KEYWORDS.some(k => lower.includes(k)),
    website_alt: isOldWebsite(lower),
    email: extractEmail(html),
    whatsapp: extractWhatsApp(html),
    kontaktformular_url: form.url,
    kontaktformular_typ: form.type,
    form_confidence: form.confidence,
    social_links: extractSocialLinks(html),
    quality_flags: qualityFlags,
    meta: extractMeta(html),
    evidence,
  };
}

function collectEvidence(
  html: string,
  url: string,
  form: { url?: string; type?: string; confidence?: number },
  qualityFlags: string[]
): string[] {
  const lower = html.toLowerCase();
  const evidence: string[] = [`Website erreichbar: ${url}`];
  if (CHATBOT_KEYWORDS.some(k => lower.includes(k))) evidence.push('Chatbot-/Livechat-Signal im HTML gefunden');
  else evidence.push('Kein bekanntes Chatbot-Signal im HTML gefunden');
  if (WHATSAPP_PATTERNS.some(p => p.test(html))) evidence.push('Oeffentlicher WhatsApp-Link gefunden');
  if (BOOKING_PATTERNS.some(p => p.test(html))) evidence.push('Online-Terminbuchungs-/Booking-Signal gefunden');
  else evidence.push('Kein klares Online-Buchungs-Signal gefunden');
  if (NOTDIENST_KEYWORDS.some(k => lower.includes(k))) evidence.push('Notdienst-/24h-Erreichbarkeits-Hinweis gefunden');
  if (isOldWebsite(lower)) evidence.push('Technisches Alt-Signal gefunden: fehlender viewport oder alte Bibliotheken');
  const email = extractEmail(html);
  if (email) evidence.push(`Oeffentliche E-Mail gefunden: ${email}`);
  if (form.url) evidence.push(`HTML-Formular/Kontaktformular gefunden: ${form.url} (${form.type ?? 'unbekannt'}, Confidence ${form.confidence ?? 60})`);
  for (const [type, link] of Object.entries(extractSocialLinks(html))) {
    evidence.push(`Social Media gefunden: ${type} ${link}`);
  }
  for (const flag of qualityFlags) evidence.push(`Website-Relaunch-Signal: ${flag}`);
  return evidence;
}

function isOldWebsite(html: string): boolean {
  const oldSignals = OLD_SIGNALS.filter(s => html.includes(s)).length;
  const hasViewport = html.includes('viewport');
  return oldSignals >= 2 || !hasViewport;
}

// Rollen-Adressen sind fast immer die richtige Geschäfts-Mail (nicht die private des Webmasters).
const EMAIL_ROLE_PREFIXES = [
  'info', 'kontakt', 'mail', 'email', 'office', 'buero', 'sekretariat', 'empfang',
  'service', 'anfrage', 'praxis', 'kanzlei', 'zentrale', 'post', 'hallo', 'team', 'moin',
];
const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

function extractEmail(html: string): string | undefined {
  const candidates = collectEmailCandidates(html);
  if (!candidates.length) return undefined;
  // Rollen-Adresse bevorzugen, sonst die erste plausible Geschäfts-Mail.
  const role = candidates.find(e => EMAIL_ROLE_PREFIXES.some(p => e.startsWith(p + '@')));
  return role ?? candidates[0];
}

function collectEmailCandidates(html: string): string[] {
  const found: string[] = [];
  const push = (raw?: string | null) => {
    if (!raw) return;
    const e = raw.trim().replace(/^mailto:/i, '').split('?')[0].toLowerCase();
    if (isLikelyBusinessEmail(e) && !found.includes(e)) found.push(e);
  };
  // Viele deutsche Seiten kodieren die Adresse als HTML-Entities gegen Spam-Bots
  // (z.B. &#105;&#x6E;&#102;&#x6F;&#64;… = info@…). Deshalb zusätzlich dekodiert durchsuchen.
  const decoded = decodeHtmlEntities(html);
  for (const source of decoded === html ? [html] : [html, decoded]) {
    // 1. mailto:-Links – zuverlässigste Quelle
    for (const m of source.matchAll(/mailto:([^"'?\s>]+)/gi)) push(m[1]);
    // 2. Klartext-E-Mails im HTML
    for (const m of source.match(EMAIL_RE) ?? []) push(m);
  }
  // 3. Verschleierungen aufloesen: info(at)firma.de, info [at] firma [dot] de
  for (const m of deobfuscateEmails(decoded).match(EMAIL_RE) ?? []) push(m);
  return found;
}

/** Wandelt numerische HTML-Entities (&#105; dezimal und &#x6E; hex) zurueck in Zeichen. */
export function decodeHtmlEntities(text: string): string {
  if (!text.includes('&#')) return text;
  const toChar = (code: number): string => {
    if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) return '';
    try { return String.fromCodePoint(code); } catch { return ''; }
  };
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => toChar(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => toChar(parseInt(dec, 10)));
}

function deobfuscateEmails(html: string): string {
  return html
    .replace(/&#0*64;/g, '@').replace(/&#0*46;/g, '.')
    .replace(/\s*[\[({<]\s*(?:at|@)\s*[\])}>]\s*/gi, '@')
    .replace(/\s*[\[({<]\s*(?:dot|punkt)\s*[\])}>]\s*/gi, '.');
}

function extractWhatsApp(html: string): string | undefined {
  const decoded = html.replace(/&amp;/g, '&');
  const m = decoded.match(/wa\.me\/(\+?[\d]+)/i)
    || decoded.match(/whatsapp\.com\/send\?phone=(\+?[\d]+)/i)
    || decoded.match(/api\.whatsapp\.com\/send\?phone=(\+?[\d]+)/i);
  if (!m) return undefined;
  const number = m[1].replace(/^\+/, '');
  return `https://wa.me/${number}`;
}

function extractKontaktformular(html: string, base: string): { url?: string; type?: string; confidence?: number } {
  const embedded = extractEmbeddedForm(html, base);
  if (embedded.url) return embedded;

  const re = /href=["']([^"']*(?:kontakt|contact|anfrage|schreib)[^"']*)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const href = m[1];
    if (!isLikelyContactHref(href)) continue;
    if (href.startsWith('http')) return { url: href, type: 'Kontaktseite', confidence: 70 };
    if (href.startsWith('/')) {
      try { return { url: new URL(href, base).toString(), type: 'Kontaktseite', confidence: 70 }; } catch { return {}; }
    }
  }
  return {};
}

function extractEmbeddedForm(html: string, base: string): { url?: string; type?: string; confidence?: number } {
  const forms = html.match(/<form[\s\S]*?<\/form>/gi) ?? [];
  for (const form of forms) {
    const lower = form.toLowerCase();
    const fields = [
      /name=["'][^"']*(email|mail)[^"']*["']/i,
      /type=["']email["']/i,
      /name=["'][^"']*(tel|phone|telefon)[^"']*["']/i,
      /textarea/i,
      /name=["'][^"']*(message|nachricht|anfrage|text)[^"']*["']/i,
      /type=["']submit["']/i,
      />([^<]*(senden|anfrage|kontakt|termin)[^<]*)</i,
    ].filter(pattern => pattern.test(form)).length;
    if (fields < 2) continue;

    const action = form.match(/action=["']([^"']+)["']/i)?.[1];
    const type = lower.includes('termin') ? 'Terminformular' : lower.includes('angebot') || lower.includes('anfrage') ? 'Anfrageformular' : 'Kontaktformular';
    const confidence = Math.min(95, 55 + fields * 7);
    try {
      return { url: action ? new URL(action, base).toString() : base, type, confidence };
    } catch {
      return { url: base, type, confidence };
    }
  }
  return {};
}

function extractSocialLinks(html: string): Partial<Record<SocialKanal, string>> {
  const links: Partial<Record<SocialKanal, string>> = {};
  const hrefs = html.matchAll(/href=["']([^"']+)["']/gi);
  for (const match of hrefs) {
    const href = match[1].replace(/&amp;/g, '&').trim();
    const social = classifySocialProfileUrl(href);
    if (social && !links[social.type]) links[social.type] = social.url;
  }
  return links;
}

function classifySocialProfileUrl(href: string): { type: SocialKanal; url: string } | undefined {
  if (!/^https?:\/\//i.test(href)) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return undefined;
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const segments = parsed.pathname.split('/').filter(Boolean);
  const first = (segments[0] ?? '').toLowerCase();

  if (host === 'instagram.com') {
    if (segments.length !== 1 || isGenericSocialPath(first)) return undefined;
    return { type: 'instagram', url: href };
  }

  if (host === 'facebook.com' || host === 'fb.com') {
    if (segments.length !== 1 || isGenericSocialPath(first)) return undefined;
    return { type: 'facebook', url: href };
  }

  if (host === 'tiktok.com') {
    if (segments.length !== 1 || !first.startsWith('@') || first.length < 3) return undefined;
    return { type: 'tiktok', url: href };
  }

  if (host === 'linkedin.com') {
    if (segments.length < 2) return undefined;
    if (!['company', 'in'].includes(first)) return undefined;
    if (isGenericSocialPath((segments[1] ?? '').toLowerCase())) return undefined;
    return { type: 'linkedin', url: href };
  }

  if (host === 'youtube.com') {
    if (segments.length < 1) return undefined;
    if (first.startsWith('@') && first.length > 1) return { type: 'youtube', url: href };
    if (['channel', 'user', 'c'].includes(first) && segments[1]) return { type: 'youtube', url: href };
  }

  return undefined;
}

function isGenericSocialPath(segment: string): boolean {
  return GENERIC_SOCIAL_PATHS.has(segment) || segment.includes('.') || segment.length < 2;
}

function collectQualityFlags(html: string, url: string, durationMs: number): string[] {
  const lower = html.toLowerCase();
  const flags: string[] = [];
  if (!url.startsWith('https://')) flags.push('Kein HTTPS');
  if (!lower.includes('viewport')) flags.push('Kein Mobile-Viewport');
  if (OLD_SIGNALS.some(signal => lower.includes(signal))) flags.push('Alte Technik/Bibliothek erkannt');
  if (stripTags(html).length < 700) flags.push('Sehr wenig sichtbarer Inhalt');
  if (!CTA_PATTERNS.some(pattern => pattern.test(html))) flags.push('Keine klare CTA erkannt');
  if (!/leistung|service|angebot|sanit|heizung|elektro|klima|pflege|transport|restaurant|studio/i.test(html)) flags.push('Keine klare Leistungsbeschreibung erkannt');
  if (durationMs > 8000) flags.push('Langsame Website-Antwort');
  return flags;
}

function stripTags(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function isLikelyBusinessEmail(email: string): boolean {
  const lower = email.toLowerCase();
  if (SPAM_EMAIL_DOMAINS.some(d => lower.includes(d))) return false;
  const tld = lower.split('.').pop() ?? '';
  if (ASSET_EXTENSIONS.includes(tld)) return false;
  if (/(^|[-_])\d+x[-_]\d+\./i.test(lower)) return false;
  return /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i.test(email);
}

export function isLikelyContactHref(href: string): boolean {
  const lower = href.toLowerCase();
  if (lower.includes('/wp-content/') || lower.includes('/plugins/') || lower.includes('/themes/')) return false;
  if (/\.(css|js|png|jpg|jpeg|gif|webp|svg|woff2?|ttf|ico)(\?|$)/i.test(lower)) return false;
  return /kontakt|contact|anfrage|schreib/i.test(href);
}

function extractMeta(html: string): Record<string, string> {
  const meta: Record<string, string> = {};
  const title = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (title) meta.title = title[1].trim().slice(0, 100);
  const desc = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
  if (desc) meta.description = desc[1].trim().slice(0, 200);
  return meta;
}

function emptyResult(error: string): WebsiteAnalysis {
  return {
    accessible: false,
    hat_chatbot: false,
    hat_whatsapp_link: false,
    hat_online_buchung: false,
    hat_faq: false,
    hat_notdienst_hinweis: false,
    website_alt: false,
    social_links: {},
    quality_flags: [],
    error,
  };
}
