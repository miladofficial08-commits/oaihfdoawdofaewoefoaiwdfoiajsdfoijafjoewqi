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
  for (const u of candidateContactUrls(homeHtml, base).slice(0, 5)) {
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
  // "Vertretungsberechtigte Gesellschafter: …" ist eine Standardformel in GmbH-Impressen.
  'vertretungsberechtigt[a-zäöüß]*(?:\\s+(?:gesch[äa]ftsf[üu]hrer(?:in)?|gesellschafter(?:in)?|person(?:en)?))?',
  'vertreten durch',
  'inhaber(?:in)?',
];
// Optionale Titel/Anrede + 2–4 großgeschriebene Namensteile.
const NAME_PART = "[A-ZÄÖÜ][a-zäöüß]+(?:[-'][A-ZÄÖÜ][a-zäöüß]+)?";
const NAME_RE = "(?:Herr |Frau |Dr\\.? |Prof\\.? |Dipl\\.-?[A-Za-zäöüß]+\\.? )*" + NAME_PART + "(?:\\s+" + NAME_PART + "){1,3}";
// Wortgrenzen (\b) sind wichtig: sonst matcht z.B. "ust" (von USt) im Namen "Mustermann".
const GF_BLOCKWORDS = /\b(gmbh|kg|ohg|gbr|mbh|ug|ag|handelsregister|registergericht|amtsgericht|gericht|umsatzsteuer|steuernummer|steuer|ust|hrb|hra|impressum|telefon|telefax|fax|e-?mail|vertreten|gesch[äa]ftsf[üu]hr\w*|inhaber\w*|adresse|stra[sß]e|platz|allee|weg)\b/i;
const GF_TITLES = /^(Herr|Frau|Dr\.?|Prof\.?|Dipl\.?-?[A-Za-zäöüß]*\.?)$/i;
// Nur zum ABSCHNEIDEN nachlaufender Wörter (Berufe/Rechtsform/Adresse/Navigation) – NICHT zum
// Verwerfen, damit echte Nachnamen wie "Meister" erhalten bleiben. Deckt die real beobachteten
// Bleed-in-Muster ab: Kammer/Innung, Straßennamen, Navigations- und Füllwörter.
const GF_TRAILING_NOISE = /^(installateur|meister|elektromeister|handwerksmeister|klempnermeister|heizungsbaumeister|ingenieur|techniker|monteur|inhaber|gesch[äa]ftsf[üu]hr\w*|vertretungsberechtigt\w*|vertreten|gmbh|kg|ohg|gbr|mbh|ug|ag|co|handelsregister|registergericht|amtsgericht|ust|hrb|hra|steuernummer|telefon|telefax|fax|impressum|datenschutz|adresse|kontakt|home|start|menu|men[üu]|handwerkskammer|kammer|innung|mitglied|streitschlichtung|verbraucherschlichtungsstelle|die|der|das|und|[a-zäöüß]*(?:stra[sß]e|str\.?|weg|platz|allee|ring|gasse))$/i;

// Wandelt HTML in Text um, behält aber Block-Grenzen als "|" – so kann der Namens-Regex
// nicht über eine Zeilen-/Absatzgrenze hinweg greifen und zieht keine Adresse ("… Kraspothstr"),
// Navigation ("… START KONTAKT") oder Zusätze ("… Handwerkskammer Düsseldorf") in den Namen.
function stripTagsWithBoundaries(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(?:br|\/p|\/div|\/li|\/td|\/tr|\/h[1-6]|\/span|\/a|\/strong|\/b)\b[^>]*>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ');
}

// Branchenwörter tauchen in Firmennamen auf ("Zimmer Haustechnik"), aber nie in
// Personennamen – ohne diese Sperre landet die Firma selbst als "Geschäftsführer"
// in der Anrufliste und die Anrede beim Anruf ist falsch.
// Zusätzlich Agenturwörter: viele Impressen nennen die Werbeagentur, die die Seite
// gebaut hat ("Schlütersche Marketing Holding") – die landet sonst als Ansprechpartner
// in der Anrufliste.
const GF_BRANCHENWORT = /\b(haustechnik|sanit[äa]r|heizung\w*|elektro\w*|klima|k[äa]lte|bedachung\w*|dachdecker|installation\w*|technik|service|energie|solar|immobilien|automobile|autohaus|werkstatt|betrieb|bau|holding|marketing|media|agentur|verlag|werbung|webdesign|consulting|solutions|systeme|kommunikation)\b/i;

/** Prüft, ob der gefundene "Name" in Wahrheit nur der Firmenname ist. */
function istFirmenname(name: string, firmenname?: string): boolean {
  if (!firmenname) return false;
  const zerlegen = (s: string) => new Set(s.toLowerCase().replace(/[^a-zäöüß\s]/g, ' ').split(/\s+/).filter(w => w.length > 2));
  const firma = zerlegen(firmenname);
  const teile = [...zerlegen(name)];
  return teile.length > 0 && teile.every(w => firma.has(w));
}

export function extractGeschaeftsfuehrer(html: string, firmenname?: string): string | undefined {
  const text = stripTagsWithBoundaries(decodeHtmlEntities(html))
    .replace(/&auml;/g, 'ä').replace(/&ouml;/g, 'ö').replace(/&uuml;/g, 'ü').replace(/&szlig;/g, 'ß')
    .replace(/&Auml;/g, 'Ä').replace(/&Ouml;/g, 'Ö').replace(/&Uuml;/g, 'Ü')
    .replace(/[ \t]*\|[ \t]*/g, ' | ');
  for (const label of GF_LABELS) {
    // Separator Label→Name darf auch die eingefügte Block-Grenze "|" enthalten
    // (z.B. Impressum-Tabelle <td>Geschäftsführer</td><td>Name</td>), der Name selbst nicht.
    const re = new RegExp(label + "\\s*[:\\-–—|]*\\s*(" + NAME_RE + ")", 'i');
    const m = text.match(re);
    if (!m || !m[1]) continue;
    const name = refineNameWords(m[1].trim().replace(/\s+/g, ' ').split(' '));
    if (name && isPlausiblePersonName(name) && !istFirmenname(name, firmenname)) return name.slice(0, 60);
  }
  return undefined;
}

// Formt aus rohen Wortteilen einen sauberen Personennamen:
//  1. führende Titel + Berufs-/Füllwörter weg ("Handwerksmeister Klaus …" → "Klaus …")
//  2. nur der führende Block großgeschriebener Wörter (schneidet "und"/"von"/Kleingeschriebenes ab)
//  3. auf max. 3 Wörter kappen (Bleed-in aus Folgezeilen ohne HTML-Grenzen)
//  4. nachlaufende Berufs-/Adress-/Navigations-Wörter abschneiden
function refineNameWords(input: string[]): string {
  let words = input.slice();
  while (words.length > 1 && (GF_TITLES.test(words[0]) || GF_TRAILING_NOISE.test(words[0]))) words.shift();
  const cut = words.findIndex(w => !/^[A-ZÄÖÜ]/.test(w));
  if (cut > 0) words = words.slice(0, cut);
  if (words.length > 3) words = words.slice(0, 3);
  while (words.length > 2 && GF_TRAILING_NOISE.test(words[words.length - 1])) words.pop();
  return words.join(' ');
}

// Bereinigt EINEN bereits gespeicherten GF-String (ohne Website neu zu laden). Für Alt-Daten,
// die vor der verbesserten Extraktion mit angehängtem Müll (Straße, Kammer, Navigation) gespeichert
// wurden. Gibt den bereinigten Namen zurück oder undefined, wenn kein plausibler Name übrig bleibt.
export function cleanStoredGf(raw: string | null | undefined): string | undefined {
  if (!raw || !raw.trim()) return undefined;
  const name = refineNameWords(raw.trim().replace(/\s+/g, ' ').split(' '));
  return name && isPlausiblePersonName(name) ? name.slice(0, 60) : undefined;
}

function isPlausiblePersonName(name: string): boolean {
  if (/\d/.test(name)) return false;
  if (GF_BLOCKWORDS.test(name)) return false;
  if (GF_BRANCHENWORT.test(name)) return false;
  const words = name.split(/\s+/).filter(w => !GF_TITLES.test(w));
  return words.length >= 2 && words.length <= 3 && words.every(w => /^[A-ZÄÖÜ]/.test(w));
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
    if (!/impressum|imprint|kontakt|contact|datenschutz/i.test(href)) continue;
    try { add(new URL(href, base).toString()); } catch { /* ungültiger href */ }
  }
  // 2. Standard-Pfade als Fallback, falls kein Link im HTML steht.
  //    Datenschutz/-erklärung nennt nach DSGVO Art. 13 fast immer die Verantwortlichen-E-Mail.
  for (const p of [
    '/impressum', '/impressum/', '/impressum.html', '/impressum.php',
    '/kontakt', '/kontakt/', '/contact', '/imprint',
    '/datenschutz', '/datenschutz/', '/datenschutzerklaerung',
  ]) {
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
  // 0. Cloudflare Email Protection zuerst – sehr verbreitet, sonst bleibt die Mail unsichtbar.
  for (const e of decodeCloudflareEmails(html)) push(e);
  // 1. data-email/data-mail-Attribute (JS-Seiten setzen die Adresse oft nur dort).
  for (const m of html.matchAll(/data-(?:email|mail)=["']([^"']+@[^"']+)["']/gi)) push(m[1]);
  // Viele deutsche Seiten kodieren die Adresse als HTML-Entities gegen Spam-Bots
  // (z.B. &#105;&#x6E;&#102;&#x6F;&#64;… = info@…). Deshalb zusätzlich dekodiert durchsuchen.
  // Zusätzlich HTML-Kommentare entfernen – "info<!-- -->@firma.de" ist eine gängige Verschleierung.
  const decoded = decodeHtmlEntities(html);
  const noComments = decoded.replace(/<!--[\s\S]*?-->/g, '');
  const sources = new Set([html, decoded, noComments]);
  for (const source of sources) {
    // mailto:-Links – zuverlässigste Quelle
    for (const m of source.matchAll(/mailto:([^"'?\s>]+)/gi)) push(m[1]);
    // Klartext-E-Mails im HTML
    for (const m of source.match(EMAIL_RE) ?? []) push(m);
  }
  // Verschleierungen aufloesen: info(at)firma.de, info [at] firma [dot] de
  for (const m of deobfuscateEmails(noComments).match(EMAIL_RE) ?? []) push(m);
  return found;
}

/**
 * Cloudflare "Email Address Protection" verschlüsselt Mail-Adressen client-seitig:
 * <a href="/cdn-cgi/l/email-protection#HEX"> bzw. <span data-cfemail="HEX">.
 * Das erste Byte ist der XOR-Schlüssel, der Rest die XOR-verschlüsselte Adresse.
 * Ohne dieses Decoding bleiben solche Seiten (sehr viele) fälschlich "ohne E-Mail".
 */
export function decodeCloudflareEmails(html: string): string[] {
  const out: string[] = [];
  const decode = (hex: string): string | undefined => {
    if (hex.length < 4 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return undefined;
    const key = parseInt(hex.slice(0, 2), 16);
    let email = '';
    for (let i = 2; i < hex.length; i += 2) {
      email += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
    }
    return /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email) ? email : undefined;
  };
  for (const m of html.matchAll(/data-cfemail=["']([0-9a-fA-F]+)["']/gi)) {
    const e = decode(m[1]); if (e) out.push(e);
  }
  for (const m of html.matchAll(/\/cdn-cgi\/l\/email-protection#([0-9a-fA-F]+)/gi)) {
    const e = decode(m[1]); if (e) out.push(e);
  }
  return out;
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

// ─────────────────────────────────────────────────────────────────────────────
// Impressum-Extraktor: Durchwahl statt Zentrale
//
// Die Nummer aus Google Maps ist die Zentrale – genau die Leitung, die eine
// Bürokraft abschirmt. Das Impressum (§5 DDG) nennt dagegen oft eine Mobil-
// oder Durchwahlnummer, unter der der Inhaber selbst rangeht. Genau die wird
// hier gezogen, zusammen mit dem Namen des Geschäftsführers.
// ─────────────────────────────────────────────────────────────────────────────

const PHONE_LABEL_NOTDIENST = /(notdienst|notfall|notruf|bereitschaft|st[öo]rungsdienst|24\s?[-/]?\s?(?:h\b|std)|rund um die uhr)/i;
const PHONE_LABEL_MOBIL = /(mobil|handy|mobiltelefon)/i;
const PHONE_LABEL_FAX = /(fax|telefax)/i;
const PHONE_LABEL_DIREKT = /(durchwahl|direkt|gesch[äa]ftsf[üu]hr|inhaber|meister)/i;

// Nur führende 0 / +49 / 0049, KEIN Punkt als Trenner (sonst matchen Datumsangaben
// wie "01.01.2024" als Rufnummer). 8–14 Ziffern gesamt.
const PHONE_RE = /(?<![\d/])(?:\+49|0049|0)[\s\-/()]*(?:\d[\s\-/()]*){7,13}\d/g;

export type TelefonTyp = 'mobil' | 'notdienst' | 'festnetz';

export interface ExtractedPhone {
  nummer: string;
  typ: TelefonTyp;
  kontext?: string;
}

export interface ImpressumResult {
  geschaeftsfuehrer?: string;
  /** Mobil-/Durchwahlnummer für den Direktkontakt – nie die Zentrale, nie der Notdienst. */
  telefon_direkt?: string;
  telefon_direkt_typ?: TelefonTyp;
  /** Bewusst getrennt gespeichert: Notdienstleitungen sind für Notfälle, nicht für Akquise. */
  telefon_notdienst?: string;
  whatsapp?: string;
  impressum_url?: string;
  alle_nummern: ExtractedPhone[];
  error?: string;
}

/** Bringt eine deutsche Rufnummer auf +49… oder verwirft sie als unplausibel. */
export function normalizeDePhone(raw: string): string | undefined {
  if (/\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/.test(raw)) return undefined; // Datum, keine Rufnummer
  let d = raw.replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1).replace(/\+/g, '');
  else d = d.replace(/\+/g, '');

  if (d.startsWith('0049')) d = d.slice(4);
  else if (d.startsWith('49') && raw.trim().startsWith('+')) d = d.slice(2);
  else if (d.startsWith('0')) d = d.slice(1);
  else return undefined;

  // Ortsnetz + Teilnehmer: realistisch 6–12 Ziffern nach der Landesvorwahl.
  if (d.length < 6 || d.length > 12) return undefined;
  if (/^(\d)\1+$/.test(d)) return undefined; // 0000000 / 1111111 = Platzhalter
  return `+49${d}`;
}

// Das Label steht im Deutschen vor der Nummer ("Mobil: 0171…"). Entscheidend ist, nur
// bis zur Feldgrenze zurückzulesen: sonst zieht das "Telefax:" der Zeile darüber die
// darunterstehende Mobilnummer mit in den Fax-Ausschluss.
function labelVor(kontext: string, rawLen: number): string {
  const vor = kontext.slice(0, Math.max(0, kontext.length - rawLen));
  const grenze = Math.max(vor.lastIndexOf('|'), vor.lastIndexOf(';'), vor.lastIndexOf('•'));
  return (grenze >= 0 ? vor.slice(grenze + 1) : vor).slice(-60);
}

function classifyPhone(nummer: string, label: string): TelefonTyp {
  if (PHONE_LABEL_NOTDIENST.test(label)) return 'notdienst';
  if (/^\+491[567]/.test(nummer)) return 'mobil';
  if (PHONE_LABEL_MOBIL.test(label)) return 'mobil';
  return 'festnetz';
}

const TYP_RANG: Record<TelefonTyp, number> = { notdienst: 3, mobil: 2, festnetz: 1 };

/** Zieht alle plausiblen Rufnummern samt Kontext-Label aus einer Seite. Faxnummern fliegen raus. */
export function extractPhones(html: string): ExtractedPhone[] {
  const found = new Map<string, ExtractedPhone>();

  const merge = (raw: string, kontext: string) => {
    const nummer = normalizeDePhone(raw);
    if (!nummer) return;
    const label = labelVor(kontext, raw.length);
    if (PHONE_LABEL_FAX.test(label)) return;
    const typ = classifyPhone(nummer, label);
    const bisher = found.get(nummer);
    if (!bisher || TYP_RANG[typ] > TYP_RANG[bisher.typ]) {
      found.set(nummer, { nummer, typ, kontext: label.replace(/\s+/g, ' ').trim() });
    }
  };

  // 1. tel:-Links – die zuverlässigste Quelle, weil der Betreiber sie selbst gesetzt hat.
  const telRe = /href=["']tel:([^"']{5,30})["']/gi;
  let m: RegExpExecArray | null;
  while ((m = telRe.exec(html))) {
    const vorlauf = stripTagsWithBoundaries(html.slice(Math.max(0, m.index - 220), m.index));
    merge(m[1], `${vorlauf} ${m[1]}`);
  }

  // 2. Fließtext (Impressen listen Nummern oft ohne tel:-Link).
  const text = stripTagsWithBoundaries(decodeHtmlEntities(html));
  while ((m = PHONE_RE.exec(text))) {
    merge(m[0], text.slice(Math.max(0, m.index - 60), m.index + m[0].length));
  }
  PHONE_RE.lastIndex = 0;

  return [...found.values()];
}

/**
 * Lädt Startseite + Impressum/Kontakt und liefert die Daten, die einen Kaltanruf
 * in ein Gespräch verwandeln: Name des Entscheiders und eine Nummer, die nicht
 * in der Zentrale endet.
 *
 * @param zentrale Bereits bekannte Nummer (Google Maps) – wird nie als Direktnummer zurückgegeben.
 * @param firmenname Verhindert, dass der Firmenname selbst als Geschäftsführer durchgeht.
 */
export async function analyzeImpressum(url: string, zentrale?: string, firmenname?: string): Promise<ImpressumResult> {
  const leer: ImpressumResult = { alle_nummern: [] };
  if (!url) return { ...leer, error: 'Keine URL' };

  const normalized = url.startsWith('http') ? url : `https://${url}`;
  try {
    const home = await fetchPage(normalized);
    if (home.status && home.status >= 400) return { ...leer, error: `HTTP ${home.status}` };
    if (home.html == null) return { ...leer, error: 'Timeout' };

    const nummern = new Map<string, ExtractedPhone>();
    const sammle = (liste: ExtractedPhone[]) => {
      for (const p of liste) {
        const bisher = nummern.get(p.nummer);
        if (!bisher || TYP_RANG[p.typ] > TYP_RANG[bisher.typ]) nummern.set(p.nummer, p);
      }
    };

    let gf = extractGeschaeftsfuehrer(home.html, firmenname);
    let whatsapp = extractWhatsApp(home.html);
    let impressumUrl: string | undefined;
    sammle(extractPhones(home.html));

    for (const u of candidateContactUrls(home.html, home.finalUrl).slice(0, 4)) {
      try {
        const page = await fetchPage(u);
        if (!page.html) continue;
        if (!impressumUrl && /impressum|imprint/i.test(u)) impressumUrl = u;
        sammle(extractPhones(page.html));
        if (!gf) gf = extractGeschaeftsfuehrer(page.html, firmenname);
        if (!whatsapp) whatsapp = extractWhatsApp(page.html);
      } catch { /* Unterseite nicht erreichbar – Rest zählt trotzdem */ }
    }

    const alle = [...nummern.values()];
    const zentraleNorm = zentrale ? normalizeDePhone(zentrale) : undefined;
    const istZentrale = (p: ExtractedPhone) => zentraleNorm != null && p.nummer === zentraleNorm;

    const notdienst = alle.find(p => p.typ === 'notdienst' && !istZentrale(p));
    const kandidaten = alle.filter(p => p.typ !== 'notdienst' && !istZentrale(p));
    const direkt =
      kandidaten.find(p => p.typ === 'mobil') ??
      kandidaten.find(p => p.typ === 'festnetz' && PHONE_LABEL_DIREKT.test(p.kontext ?? ''));

    return {
      geschaeftsfuehrer: gf,
      telefon_direkt: direkt?.nummer,
      telefon_direkt_typ: direkt?.typ,
      telefon_notdienst: notdienst?.nummer,
      whatsapp,
      impressum_url: impressumUrl,
      alle_nummern: alle,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ...leer, error: msg.includes('abort') ? 'Timeout' : msg.slice(0, 100) };
  }
}
