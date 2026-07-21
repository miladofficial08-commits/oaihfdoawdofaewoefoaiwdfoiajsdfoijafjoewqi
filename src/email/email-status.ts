// Leitet aus dem tatsächlichen Versand-Ergebnis (Erfolg, Anbieter-Fehlertext, Bounce, Interaktion)
// einen verständlichen, handlungsleitenden Zustellstatus ab. Ersetzt rohe technische Meldungen
// wie "technische Störung" in der primären Oberfläche. Die Original-Anbietermeldung bleibt für die
// Detailansicht erhalten (Feld error).

export type EmailStatusCode =
  | 'scheduled'        // geplant, noch nicht gesendet
  | 'processing'       // wird gerade verarbeitet
  | 'canceled'         // abgebrochen
  | 'delivered'        // zugestellt (durch Öffnung/Klick belegt)
  | 'handed_off'       // an Versanddienst übergeben (Anbieter hat angenommen)
  | 'deferred'         // vorübergehend verzögert (Greylisting/Timeout, Wiederholung möglich)
  | 'invalid_address'  // ungültige Empfängeradresse (Postfach existiert nicht)
  | 'blocked'          // vom Anbieter/Server blockiert (Spam/Reputation)
  | 'rejected'         // dauerhaft abgelehnt (permanenter 5xx-Fehler)
  | 'send_error';      // technischer Versandfehler (Verbindung/Auth/Konfiguration)

export type EmailStatusTone = 'ok' | 'good' | 'info' | 'warn' | 'bad';

export interface EmailStatusInfo {
  code: EmailStatusCode;
  label: string;
  tone: EmailStatusTone;
  explanation: string;
  recommendation?: string;
  /** True, wenn die Mail nachweislich beim Empfänger ankam oder vom Anbieter angenommen wurde. */
  reachedRecipient: boolean;
}

export interface ClassifyEmailInput {
  /** Status aus scheduled_emails, falls die Mail (noch) geplant ist. */
  scheduledStatus?: 'scheduled' | 'processing' | 'canceled' | null;
  /** success-Flag aus sent_emails (1 = vom Anbieter angenommen). */
  success?: boolean | 0 | 1 | null;
  /** Rohe Fehlermeldung des Anbieters/SMTP. */
  error?: string | null;
  /** Wurde ein Bounce (Zustellfehler) im Posteingang erkannt? */
  hasBounce?: boolean;
  bounceText?: string | null;
  /** Verlässliche Öffnung registriert (belegt Zustellung). */
  opened?: boolean;
  /** Klick registriert (belegt Zustellung eindeutig). */
  clicked?: boolean;
}

const INVALID_PATTERNS = [
  /mailbox\s+(unavailable|not\s+found)/i,
  /no\s+such\s+user/i,
  /user\s+unknown/i,
  /recipient\s+(address\s+)?rejected/i,
  /does\s+not\s+exist/i,
  /unrouteable|unroutable/i,
  /invalid\s+(recipient|address|mailbox)/i,
  /ung(ü|ue)ltige?\s+(empf(ä|ae)nger|adresse)/i,
  /550.*(5\.1\.1|user|recipient|mailbox)/i,
];

const BLOCKED_PATTERNS = [
  /spam/i,
  /blacklist|blocklist|denylist/i,
  /reputation/i,
  /blocked|gesperrt|blockiert/i,
  /policy\s+rejection/i,
  /unauthorized\s+ip/i,
  /5\.7\.\d/i,
];

const DEFERRED_PATTERNS = [
  /timeout|timed\s+out|etimedout/i,
  /greylist|graylist/i,
  /try\s+again|temporar/i,
  /rate\s?limit|too\s+many|quota|kontingent/i,
  /4\.\d\.\d/i,
  /451|421/,
];

const REJECTED_PATTERNS = [
  /not\s+verified|unauthorized\s+sender|sender.*verif/i,
  /absender.*(verifiz|best(ä|ae)tig)/i,
  /message\s+rejected/i,
  /554/,
];

function matches(patterns: RegExp[], text: string): boolean {
  return patterns.some(p => p.test(text));
}

const INFO: Record<EmailStatusCode, Omit<EmailStatusInfo, 'code'>> = {
  scheduled: {
    label: 'Geplant',
    tone: 'info',
    explanation: 'Die E-Mail ist für einen späteren Zeitpunkt eingeplant und wurde noch nicht versendet.',
    recommendation: 'Du kannst sie bis zum Versand noch bearbeiten oder stornieren.',
    reachedRecipient: false,
  },
  processing: {
    label: 'Wird verarbeitet',
    tone: 'info',
    explanation: 'Die geplante E-Mail wird gerade an den Versanddienst übergeben.',
    reachedRecipient: false,
  },
  canceled: {
    label: 'Abgebrochen',
    tone: 'warn',
    explanation: 'Der geplante Versand wurde abgebrochen und nicht gesendet.',
    reachedRecipient: false,
  },
  delivered: {
    label: 'Zugestellt',
    tone: 'good',
    explanation: 'Die E-Mail wurde zugestellt – belegt durch eine registrierte Öffnung oder einen Klick.',
    reachedRecipient: true,
  },
  handed_off: {
    label: 'An Versanddienst übergeben',
    tone: 'ok',
    explanation: 'Der Versanddienst (Brevo) hat die E-Mail angenommen. Eine Öffnung/Zustellung ist noch nicht bestätigt.',
    reachedRecipient: true,
  },
  deferred: {
    label: 'Vorübergehend verzögert',
    tone: 'warn',
    explanation: 'Der Zielserver hat die Annahme vorerst zurückgestellt (z.B. Greylisting, Zeitüberschreitung oder Rate-Limit).',
    recommendation: 'Meist ein temporäres Problem – oft klappt ein erneuter Versand kurze Zeit später.',
    reachedRecipient: false,
  },
  invalid_address: {
    label: 'Ungültige Empfängeradresse',
    tone: 'bad',
    explanation: 'Das Empfänger-Postfach existiert nicht oder wurde abgelehnt.',
    recommendation: 'E-Mail-Adresse prüfen bzw. korrigieren; diese Adresse nicht erneut anschreiben.',
    reachedRecipient: false,
  },
  blocked: {
    label: 'Vom Anbieter blockiert',
    tone: 'bad',
    explanation: 'Der Zielserver hat die E-Mail aus Reputations-/Spam-Gründen blockiert.',
    recommendation: 'Absender-Reputation und SPF/DKIM prüfen; Versandmenge drosseln.',
    reachedRecipient: false,
  },
  rejected: {
    label: 'Dauerhaft abgelehnt',
    tone: 'bad',
    explanation: 'Der Versanddienst oder Zielserver hat die E-Mail dauerhaft abgelehnt.',
    recommendation: 'Fehlermeldung in der Detailansicht prüfen (z.B. Absender nicht verifiziert).',
    reachedRecipient: false,
  },
  send_error: {
    label: 'Technischer Versandfehler',
    tone: 'bad',
    explanation: 'Die E-Mail konnte nicht an den Versanddienst übergeben werden (Verbindung, Authentifizierung oder Konfiguration).',
    recommendation: 'SMTP-/Brevo-Konfiguration prüfen. Details in der erweiterten Ansicht.',
    reachedRecipient: false,
  },
};

export function emailStatusInfo(code: EmailStatusCode): EmailStatusInfo {
  return { code, ...INFO[code] };
}

export function classifyEmailDelivery(input: ClassifyEmailInput): EmailStatusInfo {
  if (input.scheduledStatus === 'canceled') return emailStatusInfo('canceled');
  if (input.scheduledStatus === 'processing') return emailStatusInfo('processing');
  if (input.scheduledStatus === 'scheduled') return emailStatusInfo('scheduled');

  // Nachweislich zugestellt: Klick oder verlässliche Öffnung.
  if (input.clicked || input.opened) return emailStatusInfo('delivered');

  // Bounce = harter Zustellfehler aus dem Posteingang.
  if (input.hasBounce) {
    const text = String(input.bounceText || '');
    if (matches(INVALID_PATTERNS, text)) return emailStatusInfo('invalid_address');
    if (matches(BLOCKED_PATTERNS, text)) return emailStatusInfo('blocked');
    return emailStatusInfo('rejected');
  }

  const ok = input.success === true || input.success === 1;
  if (ok) return emailStatusInfo('handed_off');

  // Fehlgeschlagene Übergabe: anhand der Anbietermeldung genauer einordnen.
  const text = String(input.error || '');
  if (!text.trim()) return emailStatusInfo('send_error');
  if (matches(INVALID_PATTERNS, text)) return emailStatusInfo('invalid_address');
  if (matches(BLOCKED_PATTERNS, text)) return emailStatusInfo('blocked');
  if (matches(DEFERRED_PATTERNS, text)) return emailStatusInfo('deferred');
  if (matches(REJECTED_PATTERNS, text)) return emailStatusInfo('rejected');
  return emailStatusInfo('send_error');
}
