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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    const res = await fetch(normalized, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        'Accept-Language': 'de-DE,de;q=0.9',
      },
      redirect: 'follow',
    });
    clearTimeout(timeout);

    if (!res.ok) return emptyResult(`HTTP ${res.status}`);

    const html = await res.text();
    return analyzeHtml(html, normalized, Date.now() - startedAt, res.url);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return emptyResult(msg.includes('abort') ? 'Timeout' : msg.slice(0, 100));
  }
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

function extractEmail(html: string): string | undefined {
  const matches = html.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g) ?? [];
  return matches.find(isLikelyBusinessEmail);
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
