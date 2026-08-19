// Erkennt "Rausch"-Mails im Posteingang: Bounces, Auto-Reply, Bestätigungs-Challenges
// (z. B. italienische "Verifica profilo"), Newsletter, System-Benachrichtigungen
// (Google/united-domains/Cal.com) und persönliche Test-Accounts.
//
// Wird genutzt von:
//   • inbox.ts        — filtert die Anzeige im UI
//   • reply-scanner.ts — verhindert False-Positive "heiße Antworten"
//   • scripts/inbox-triage.cjs — löscht bereits vorhandene Rauschmails per IMAP

export type NoiseCategory =
  | 'bounce'
  | 'auto_reply'
  | 'confirmation'
  | 'list'
  | 'spam'
  | 'system'
  | 'personal'
  | 'own';

export interface NoiseInput {
  fromEmail: string;
  fromName?: string;
  subject?: string;
  headers?: string; // Roh-Header-String (falls verfügbar) — enthält List-Unsubscribe, Auto-Submitted …
}

const BOUNCE_FROM = /(mailer-daemon|postmaster|mail delivery (system|subsystem)|no[-_]?reply.*bounce)/i;
const BOUNCE_SUBJ = /(undelivered mail|delivery status|returned to sender|mail delivery failed|failure notice|unzustellbar|nicht zugestellt|zurückgeschickt|zurueckgeschickt)/i;

const AUTOREPLY_SUBJ = /(out of office|out-of-office|abwesend|abwesenheit|automatic reply|automatische antwort|automatische bestätigung|auto[- ]?reply|urlaub|vacation|ferien|autoresponder|automatische benachrichtigung|autoreply|nicht im büro|nicht im buero|urlaubsvertretung|assenza|assente|fuori sede|risposta automatica|ausser haus|außer haus|angenommen: .*(termin|meeting|call|gespräch|gespraech))/i;

// Challenge/Response & Opt-in — auch fremdsprachig ("Verifica profilo" auf Italienisch)
const CONFIRM_SUBJ = /(please confirm|bitte bestätigen|bitte bestaetigen|opt[- ]?in|double[- ]?opt|verify your email|verifizierung|captcha|challenge|whitelist|whitelisting|bestätigen sie|bestaetigen sie|are you a human|sind sie ein mensch|are you human|confermare|confirma|einmalcode|verification code|\bverify\b|verifica (profilo|delle informazioni|del tuo profilo|dell'utente|dell utente)|profil.{0,10}verifizier|verificar (perfil|cuenta)|verify your profile|profile verification)/i;

const LIST_SUBJ = /(newsletter|unsubscribe|abmelden|% off|black friday|cyber monday)/i;

const SPAM_SUBJ = /(seo|backlink|guest post|link exchange|crypto|bitcoin|nft|investment opportunity|casino|congratulations you|has been selected|selected as winner)/i;

// System-Rauschen von Plattformen, die wir betreiben (Auth, Welcome, Security)
const SYSTEM_FROM = /(^|[<\s])(no[- ]?reply|noreply|welcome|account[- ]?alerts|security|team|hello)@(google\.com|accounts\.google\.com|gmail\.com|google-noreply\.com|gmail-noreply\.com|united-domains\.de|udag\.de|cal\.com|calendar\.google\.com|hetzner\.com|strato\.de|ionos\.de|1and1\.com|apple\.com|icloud\.com|microsoft\.com|office\.com|outlook\.com)\b/i;
const SYSTEM_SUBJ = /(willkommen in ihrem .* postfach|gmail-bestätigung|sicherheitswarnung|security alert|datenschutzeinstellungen ihres google|e-mail-adresse bestätigen|new (api|smtp) key has been created|api key has been deleted|neuen ip überprüfen|neuen ip ueberpruefen)/i;

function extractEmail(raw: string): string {
  if (!raw) return '';
  const m = raw.match(/<([^>]+)>/) || raw.match(/([^\s<>"]+@[^\s<>"]+)/);
  return (m ? m[1] : raw).trim().toLowerCase();
}

let ownCache: { user: string; domain: string } | null = null;
function ownAddress() {
  if (ownCache) return ownCache;
  const raw = process.env.SMTP_FROM || process.env.SMTP_USER || '';
  const user = extractEmail(raw);
  const domain = user.split('@').pop() || '';
  ownCache = { user, domain };
  return ownCache;
}

function personalSenders(): Set<string> {
  return new Set(
    (process.env.BLOCK_PERSONAL_SENDERS || 'miladbayer11@gmail.com,miladofficial08@gmail.com')
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  );
}

/** Liefert eine Rausch-Kategorie oder null, wenn die Mail als echte Antwort zählt. */
export function noiseCategory(input: NoiseInput): NoiseCategory | null {
  const from = (input.fromEmail || '').trim().toLowerCase();
  const name = (input.fromName || '').toLowerCase();
  const subj = input.subject || '';
  const h = input.headers || '';
  const own = ownAddress();

  if (from && (from === own.user || (own.domain && from.endsWith('@' + own.domain)))) return 'own';
  if (personalSenders().has(from)) return 'personal';

  if (BOUNCE_FROM.test(from) || BOUNCE_FROM.test(name) || BOUNCE_SUBJ.test(subj)) return 'bounce';

  if (/^auto-submitted:\s*(auto-replied|auto-generated)/im.test(h)) return 'auto_reply';
  if (/^x-autoreply:\s*yes/im.test(h) || /^x-autorespond:/im.test(h) || /^precedence:\s*auto_reply/im.test(h)) return 'auto_reply';
  if (AUTOREPLY_SUBJ.test(subj)) return 'auto_reply';

  if (CONFIRM_SUBJ.test(subj)) return 'confirmation';

  if (/^list-unsubscribe:/im.test(h) || /^list-id:/im.test(h) || /^precedence:\s*bulk/im.test(h)) return 'list';
  if (LIST_SUBJ.test(subj)) return 'list';

  if (SPAM_SUBJ.test(subj)) return 'spam';

  if (SYSTEM_FROM.test(from) || SYSTEM_SUBJ.test(subj)) return 'system';

  return null;
}

export function isNoise(input: NoiseInput): boolean {
  return noiseCategory(input) !== null;
}
