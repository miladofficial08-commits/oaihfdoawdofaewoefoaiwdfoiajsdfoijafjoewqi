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
];

const MIN_SECONDS_FOR_RELIABLE_OPEN = 30;

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
