export type EmailOpenEventType = 'open' | 'open_machine' | 'open_unverified';

const MACHINE_USER_AGENT_PATTERNS = [
  /GoogleImageProxy/i,
  /Google-Image-Proxy/i,
  /GoogleImageProxy/i,
  /Microsoft Office/i,
  /Microsoft Outlook/i,
  /Outlook-iOS/i,
  /Outlook-Android/i,
  /Proofpoint/i,
  /Barracuda/i,
  /Mimecast/i,
  /SafeLinks/i,
  /Defender/i,
  /Exchange Online Protection/i,
  /EOP/i,
  /scanner/i,
  /security/i,
  /crawler/i,
  /spider/i,
  /\bbot\b/i,
  /HeadlessChrome/i,
  /curl/i,
  /python-requests/i,
  /Go-http-client/i,
  /facebookexternalhit/i,
  /Slackbot/i,
  /Discordbot/i,
  /WhatsApp/i,
  /TelegramBot/i,
  /Applebot/i,
  // Weitere Anbieter-Proxys & Scanner, die Bilder automatisch vorladen (keine echte Öffnung).
  /YahooMailProxy/i,
  /Yahoo!\s*Slurp/i,
  /YandexImages|YandexBot/i,
  /Mail\.RU/i,
  /LinkedInBot/i,
  /Twitterbot/i,
  /AhrefsBot|SemrushBot|DotBot|MJ12bot|PetalBot/i,
  /GoogleDocs|GoogleOther|Google-Read-Aloud/i,
  /Cloudflare|Cloud Front|Amazon CloudFront/i,
  /ProofpointURLDefense|urldefense/i,
  /GMX|WEB\.DE/i,
  /Zscaler|Forcepoint|Symantec|McAfee|Trend\s*Micro|Sophos/i,
];

const MIN_SECONDS_FOR_RELIABLE_OPEN = 30;

// Öffnungen desselben Empfängers innerhalb dieses Fensters gelten als EIN Vorgang
// (verhindert, dass mehrfaches Nachladen des Pixels als mehrere Öffnungen zählt).
export const OPEN_DEDUP_WINDOW_SECONDS = 120;

/**
 * Entdoppelt Öffnungs-Events zeitlich: mehrere Events mit gleicher Signatur (Gerät/IP),
 * die dicht beieinander liegen, werden zu einem einzigen Öffnungs-Vorgang zusammengefasst.
 * Erwartet Events als { signature, created_at }; gibt die Anzahl distinkter Öffnungen zurück.
 */
export function countDistinctOpens(
  events: Array<{ signature: string; created_at: string }>,
  windowSeconds: number = OPEN_DEDUP_WINDOW_SECONDS
): number {
  const bySig = new Map<string, number[]>();
  for (const e of events) {
    const t = parseTrackedTime(e.created_at)?.getTime();
    if (t == null) continue;
    const arr = bySig.get(e.signature) || [];
    arr.push(t);
    bySig.set(e.signature, arr);
  }
  let total = 0;
  for (const times of bySig.values()) {
    times.sort((a, b) => a - b);
    let last = -Infinity;
    for (const t of times) {
      if (t - last > windowSeconds * 1000) {
        total++;
        last = t;
      }
    }
  }
  return total;
}

export function parseTrackedTime(value: unknown): Date | null {
  if (!value) return null;
  const raw = String(value);
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(raw)
    ? raw.replace(' ', 'T') + 'Z'
    : raw;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function secondsBetween(start: unknown, end: unknown): number | null {
  const a = parseTrackedTime(start);
  const b = parseTrackedTime(end);
  if (!a || !b) return null;
  return Math.round((b.getTime() - a.getTime()) / 1000);
}

export function isMachineOpenUserAgent(userAgent?: string | null): boolean {
  const ua = String(userAgent || '').trim();
  if (!ua) return true;
  return MACHINE_USER_AGENT_PATTERNS.some(pattern => pattern.test(ua));
}

export function classifyOpenEvent(input: { userAgent?: string | null; secondsSinceSent?: number | null }): EmailOpenEventType {
  if (isMachineOpenUserAgent(input.userAgent)) return 'open_machine';
  const seconds = input.secondsSinceSent;
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 && seconds < MIN_SECONDS_FOR_RELIABLE_OPEN) {
    return 'open_unverified';
  }
  return 'open';
}

export function isReliableOpen(input: {
  event_type?: string | null;
  user_agent?: string | null;
  secondsSinceSent?: number | null;
}): boolean {
  if (input.event_type !== 'open') return false;
  return classifyOpenEvent({
    userAgent: input.user_agent,
    secondsSinceSent: input.secondsSinceSent,
  }) === 'open';
}

export function isOpenLikeEvent(eventType?: string | null): boolean {
  return eventType === 'open' || eventType === 'open_machine' || eventType === 'open_unverified';
}

// ── Klick-Tracking ─────────────────────────────────────────────────────────
// Firmen-Mailscanner (Outlook SafeLinks, Proofpoint, Mimecast, Barracuda …) folgen
// automatisch JEDEM Link in einer Mail, um ihn auf Schadcode zu prüfen. Ohne Filterung
// zählt jeder solche Scan als echter Klick und bläht die Statistik auf.
export type EmailClickEventType = 'click' | 'click_machine';

export function classifyClickEvent(userAgent?: string | null): EmailClickEventType {
  return isMachineOpenUserAgent(userAgent) ? 'click_machine' : 'click';
}

// Echter Klick: gespeicherter Typ 'click' UND kein Maschinen-/Scanner-User-Agent.
// Die zweite Prüfung fängt auch Alt-Daten ab, die vor der Klassifizierung noch
// pauschal als 'click' gespeichert wurden.
export function isRealClick(input: { event_type?: string | null; user_agent?: string | null }): boolean {
  if (input.event_type !== 'click') return false;
  return !isMachineOpenUserAgent(input.user_agent);
}

export function isClickLikeEvent(eventType?: string | null): boolean {
  return eventType === 'click' || eventType === 'click_machine';
}

// Entdoppelt Klicks je (Link + Gerät/IP) im Zeitfenster – analog zu Öffnungen,
// damit mehrfaches Nachladen/Prefetch nicht als mehrere Klicks zählt.
export function countDistinctClicks(
  events: Array<{ url?: string | null; signature: string; created_at: string }>,
  windowSeconds: number = OPEN_DEDUP_WINDOW_SECONDS
): number {
  return countDistinctOpens(
    events.map(e => ({ signature: `${e.url || 'unknown'}|${e.signature}`, created_at: e.created_at })),
    windowSeconds
  );
}
