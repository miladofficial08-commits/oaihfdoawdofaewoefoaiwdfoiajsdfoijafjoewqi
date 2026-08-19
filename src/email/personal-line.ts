import { Lead } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Ein Satz, der beweist: Wir haben uns diesen Betrieb angesehen.
//
// Die Messung war eindeutig: 1823 zugestellte Mails, 451 echte Öffnungen, EINE
// Antwort. Die Leute lesen – und antworten nicht, weil in der Mail kein einziger
// Satz steht, den nicht auch 500 andere bekommen hätten.
//
// Zwei Regeln, die diese Datei streng einhält:
//
//   1. KEINE KI. Jeder Satz entsteht aus Feldern, die wir tatsächlich erhoben
//      haben. Ein frei erfundenes „Ich habe gesehen, dass …" ist schlimmer als
//      gar keine Personalisierung: Wer merkt, dass die Beobachtung nicht stimmt,
//      ist als Kunde für immer weg.
//   2. Nur Nachprüfbares. Öffnungszeiten, Bewertung, die eigene Website – Dinge,
//      die der Empfänger selbst kennt und sofort wiedererkennt.
//
// Gibt es zu einem Betrieb nichts Belastbares, kommt KEIN Satz. Lieber eine
// neutrale Mail als eine, die falsch behauptet, man kenne den Laden.
// ─────────────────────────────────────────────────────────────────────────────

interface Oeffnungszeit { day?: string; hours?: string }

function parseJson<T>(raw: unknown): T | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

/** Domain ohne Protokoll und www – so, wie der Inhaber seine Seite nennt. */
function domainOf(website: string | null | undefined): string {
  const w = (website || '').trim();
  if (!w) return '';
  const d = w.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/.*$/, '');
  // Umlaut-Domains stehen technisch als „xn--sp-energie-gebudetechnik-3bc.de" da.
  // So etwas in eine Mail zu schreiben wirkt wie ein Fehler oder wie Spam –
  // dann lieber neutral von „Ihrer Website" sprechen.
  return d.includes('xn--') ? '' : d;
}

/**
 * Ist ein Notdienst in dieser Branche überhaupt plausibel?
 *
 * Der Notdienst-Erkenner schlägt auch bei Betrieben an, die gar keinen haben –
 * beim Test stand „Sie bieten Notdienst an" in einer Mail an ein Nagelstudio.
 * Eine falsche Beobachtung ist schlimmer als gar keine: Sie beweist dem Leser,
 * dass hier eine Maschine schreibt, die seinen Betrieb nicht kennt.
 */
function notdienstPlausibel(branche: string | null | undefined): boolean {
  const b = (branche || '').toLowerCase()
    .replace(/[äöüß]/g, m => ({ 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'ß': 'ss' }[m] || m));
  return /shk|sanitaer|heizung|klima|kaelte|elektr|kfz|werkstatt|schluessel|dach|rohr|installat|abschlepp|glaser|bau|handwerk|energie/.test(b);
}

/** Deterministische Auswahl – derselbe Betrieb bekommt immer denselben Satz. */
function waehle<T>(varianten: T[], seed: string): T {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return varianten[h % varianten.length];
}

const zahl = (n: number): string => String(n).replace('.', ',');

/** Wann macht der Betrieb abends zu? Liefert die früheste Feierabend-Zeit. */
function feierabend(lead: Lead): string | null {
  const zeiten = parseJson<Oeffnungszeit[]>((lead as { google_oeffnungszeiten?: unknown }).google_oeffnungszeiten);
  if (!Array.isArray(zeiten) || !zeiten.length) return null;
  const enden: string[] = [];
  for (const z of zeiten) {
    const h = String(z?.hours || '');
    if (/geschlossen|closed/i.test(h)) continue;
    const m = h.match(/(\d{1,2}):(\d{2})\s*$/) || h.match(/to\s+(\d{1,2}):(\d{2})/i);
    if (m) enden.push(`${m[1].padStart(2, '0')}:${m[2]}`);
  }
  if (!enden.length) return null;
  return enden.sort()[0];
}

/** Ist am Wochenende zu? */
function wochenendeZu(lead: Lead): boolean {
  const zeiten = parseJson<Oeffnungszeit[]>((lead as { google_oeffnungszeiten?: unknown }).google_oeffnungszeiten);
  if (!Array.isArray(zeiten) || !zeiten.length) return false;
  const we = zeiten.filter(z => /samstag|sonntag/i.test(String(z?.day || '')));
  return we.length >= 2 && we.every(z => /geschlossen|closed/i.test(String(z?.hours || '')));
}

/**
 * Der personalisierte Einstiegssatz. Reihenfolge = Überzeugungskraft:
 * Je konkreter und je näher am eigenen Problem des Betriebs, desto weiter oben.
 */
export function personalLine(lead: Lead): string | null {
  const seed = lead.id || lead.name || '';
  const domain = domainOf(lead.website);
  const stadt = (lead.stadt || '').trim();
  const bewertung = Number((lead as { google_bewertung?: unknown }).google_bewertung);
  const reviews = Number((lead as { google_anzahl_reviews?: unknown }).google_anzahl_reviews);
  const notdienst = Boolean((lead as { hat_notdienst_hinweis?: unknown }).hat_notdienst_hinweis)
    && notdienstPlausibel(lead.branche);
  const buchung = Boolean((lead as { hat_online_buchung?: unknown }).hat_online_buchung);
  const schluss = feierabend(lead);

  // 1. Notdienst beworben, Büro macht abends zu – der stärkste Widerspruch.
  if (notdienst && schluss) {
    return waehle([
      (domain ? `auf ${domain} werben Sie mit Notdienst` : 'Sie werben mit Notdienst')
        + `, laut Google ist aber um ${schluss} Uhr Feierabend – wer danach anruft, landet vermutlich auf der Mailbox.`,
      `Sie bieten Notdienst an, das Büro ist laut Google nur bis ${schluss} Uhr besetzt. Genau in der Lücke gehen die dringenden Anrufe verloren.`,
    ], seed);
  }

  // 2. Notdienst ohne bekannte Zeiten.
  if (notdienst) {
    return waehle([
      (domain ? `auf ${domain} habe ich gesehen, dass Sie Notdienst anbieten` : 'Sie bieten Notdienst an')
        + ' – erreicht Sie dabei wirklich jeder Anruf, auch wenn alle im Einsatz sind?',
      `Sie werben mit Notdienst. Die Frage, die ich mir dabei stelle: Was passiert mit dem Anruf, wenn gerade niemand ans Telefon kann?`,
    ], seed);
  }

  // 3. Wochenende geschlossen – nachvollziehbar und konkret.
  if (wochenendeZu(lead)) {
    return waehle([
      `laut Google haben Sie samstags und sonntags geschlossen – die Anrufe kommen aber trotzdem, gerade bei privaten Auftraggebern.`,
      `Ihr Betrieb hat am Wochenende zu. Wer dann anruft und niemanden erreicht, ruft erfahrungsgemäß beim Nächsten an.`,
    ], seed);
  }

  // 4. Früher Feierabend.
  if (schluss && Number(schluss.slice(0, 2)) <= 17) {
    return waehle([
      `laut Google ist bei Ihnen um ${schluss} Uhr Schluss – was passiert eigentlich mit den Anrufen, die danach kommen?`,
      `bei Ihnen endet der Tag laut Google um ${schluss} Uhr. Die Anrufe danach sind meist die, von denen man nie erfährt.`,
    ], seed);
  }

  // 5. Gute Bewertung, aber genug Stimmen, dass es aussagekräftig ist.
  if (Number.isFinite(bewertung) && bewertung >= 4.5 && Number.isFinite(reviews) && reviews >= 15) {
    return waehle([
      `${zahl(bewertung)} Sterne bei ${reviews} Google-Bewertungen${stadt ? ' in ' + stadt : ''} – wer sich so einen Ruf aufgebaut hat, verliert ungern einen Anrufer.`,
      `bei ${reviews} Bewertungen und ${zahl(bewertung)} Sternen sprechen Ihre Kunden für Sie. Umso ärgerlicher, wenn ein Neukunde nicht durchkommt.`,
    ], seed);
  }

  // 6. Keine Online-Terminbuchung – der Erstkontakt läuft also übers Telefon.
  if (domain && !buchung) {
    return waehle([
      `auf ${domain} gibt es keine Online-Terminbuchung – der erste Kontakt läuft bei Ihnen also fast immer übers Telefon.`,
      `wer auf ${domain} einen Termin will, muss anrufen. Damit hängt jeder neue Auftrag daran, dass jemand abnimmt.`,
    ], seed);
  }

  // 7. Letzter Halt: wenigstens die eigene Seite benennen.
  if (domain) {
    return `ich habe mir ${domain} angesehen${stadt ? ' – Sie sind ja in ' + stadt + ' unterwegs' : ''}.`;
  }

  // Nichts Belastbares: dann eben kein Satz.
  return null;
}

/**
 * Setzt den Satz in einen fertigen Mailtext ein.
 *
 * Bevorzugt den Platzhalter {personalisierung}. Fehlt er – und das ist bei
 * bestehenden Vorlagen der Normalfall – wandert der Satz als eigener Absatz
 * direkt hinter die Anrede. Dort steht er an genau der Stelle, an der ein Mensch
 * entscheidet, ob er weiterliest.
 */
const grossErster = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

export function applyPersonalLine(body: string, satz: string | null): string {
  const hatPlatzhalter = /\{personalisierung\}/.test(body);
  if (hatPlatzhalter) {
    // Ohne Satz auch die leere Zeile entfernen, damit keine Lücke klafft.
    return satz
      ? body.replace(/\{personalisierung\}/g, satz)
      : body.replace(/^[ \t]*\{personalisierung\}[ \t]*\r?\n?/gm, '').replace(/\{personalisierung\}/g, '');
  }
  if (!satz) return body;

  const zeilen = body.split('\n');
  // Anrede ist die erste nicht-leere Zeile ("Guten Tag," / "Guten Tag Herr X,").
  const i = zeilen.findIndex(z => z.trim() !== '');
  if (i === -1) return grossErster(satz) + '\n\n' + body;

  const vorher = zeilen.slice(0, i + 1);
  const rest = zeilen.slice(i + 1);
  while (rest.length && rest[0].trim() === '') rest.shift();

  // Der eigene Text des Nutzers beginnt klein, weil er direkt an „Guten Tag,"
  // anschloss. Jetzt steht unser Satz dazwischen – also muss seine Zeile mit
  // einem Grossbuchstaben anfangen, sonst liest es sich wie ein Fehler.
  if (rest.length) rest[0] = grossErster(rest[0]);

  return [...vorher, '', grossErster(satz), '', ...rest].join('\n');
}

/**
 * Hebt eine fest getippte Anrede auf den bekannten Namen an.
 *
 * Die Vorlagen des Nutzers schreiben „Guten Tag," aus, nicht {gruss}. Damit
 * bliebe der Name selbst dann ungenutzt, wenn wir ihn kennen – und wir kennen
 * ihn bei jedem fünften Betrieb. Statt seine Vorlagen umzuschreiben, wird die
 * Anrede hier beim Versand ergänzt. Kennen wir keinen Namen, bleibt alles exakt
 * so, wie er es getippt hat.
 */
export function upgradeAnrede(body: string, gruss: string): string {
  if (!gruss || !/^Guten Tag \S/.test(gruss)) return body;
  return body.replace(/^([ \t]*)Guten Tag(\s*,)/m, `$1${gruss}$2`);
}
