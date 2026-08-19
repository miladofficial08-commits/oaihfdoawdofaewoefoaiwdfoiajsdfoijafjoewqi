// Den echten Text aus einer E-Mail holen.
//
// Warum das eine eigene Datei ist: Vorher wurde der rohe Body-Teil einfach als
// UTF-8 gelesen. Bei einer Base64-kodierten Mail steht dann „U1RPUCEN…" in der
// Datenbank statt „STOP!". Jede Prüfung, die danach läuft – Abmelde-Erkennung,
// Absage, Interesse – schaut auf diesen Buchstabensalat und findet nichts.
//
// Genau so ist ein ausdrückliches „STOP!" durchgerutscht und der Absender als
// Interessent einsortiert worden. Deshalb gilt ab hier: Erst dekodieren, dann
// urteilen. Niemals umgekehrt.

/** Quoted-Printable („=C3=BC", Zeilenumbruch mit „=" am Ende) → Bytes. */
function decodeQuotedPrintable(input: string): Buffer {
  const ohneSoftbreaks = input.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < ohneSoftbreaks.length; i++) {
    const c = ohneSoftbreaks[i];
    if (c === '=' && /^[0-9a-f]{2}$/i.test(ohneSoftbreaks.substr(i + 1, 2))) {
      bytes.push(parseInt(ohneSoftbreaks.substr(i + 1, 2), 16));
      i += 2;
    } else {
      for (const b of Buffer.from(c, 'utf-8')) bytes.push(b);
    }
  }
  return Buffer.from(bytes);
}

function toText(bytes: Buffer, charset: string): string {
  const cs = (charset || 'utf-8').toLowerCase();
  if (/(iso-8859|latin|windows-1252|cp1252)/.test(cs)) return bytes.toString('latin1');
  const alsUtf8 = bytes.toString('utf-8');
  // Viele Absender deklarieren keinen Zeichensatz und schicken trotzdem Latin-1
  // („f=FCr" statt „f=C3=BCr"). Als UTF-8 gelesen wird daraus ein Ersatzzeichen,
  // und aus „schnellstmöglich" wird „schnellstm?glich" – womit jede Stichwort-
  // Prüfung danach ins Leere läuft. Deshalb: bei kaputten Zeichen Latin-1 nehmen.
  if (alsUtf8.includes('�')) return bytes.toString('latin1');
  return alsUtf8;
}

/** Sieht dieser Block aus wie reines Base64? (Lang genug und nur Base64-Zeichen.) */
function sieht_nach_base64_aus(s: string): boolean {
  const kompakt = s.replace(/\s+/g, '');
  if (kompakt.length < 24) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(kompakt)) return false;
  // Echter Fließtext besteht auch aus Base64-Zeichen. Unterscheidungsmerkmal:
  // Klartext hat Leerzeichen zwischen Wörtern, Base64 hat sie nur an Zeilenenden.
  const woerter = s.trim().split(/\s+/);
  return woerter.length <= 3 || woerter.every(w => w.length > 40);
}

function striptHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
}

interface Teil { headers: string; body: string }

/** Trennt Kopfzeilen vom Text – Grenze ist die erste Leerzeile. */
function trenne(roh: string): Teil {
  const m = roh.match(/\r?\n\r?\n/);
  if (!m || m.index === undefined) return { headers: '', body: roh };
  return { headers: roh.slice(0, m.index), body: roh.slice(m.index + m[0].length) };
}

function kopf(headers: string, name: string): string {
  const m = headers.match(new RegExp('^' + name + ':\\s*([^\\r\\n]*(?:\\r?\\n[ \\t][^\\r\\n]*)*)', 'im'));
  return m ? m[1].replace(/\r?\n[ \t]+/g, ' ').trim() : '';
}

/** Einen einzelnen MIME-Teil auspacken. */
function teilText(teil: Teil): { text: string; html: boolean } {
  const ctype = kopf(teil.headers, 'Content-Type').toLowerCase();
  const cte = kopf(teil.headers, 'Content-Transfer-Encoding').toLowerCase();
  const charset = (ctype.match(/charset\s*=\s*"?([\w-]+)"?/) || [])[1] || 'utf-8';
  const html = /text\/html/.test(ctype);

  let text: string;
  if (cte.includes('base64')) {
    text = toText(Buffer.from(teil.body.replace(/\s+/g, ''), 'base64'), charset);
  } else if (cte.includes('quoted-printable')) {
    text = toText(decodeQuotedPrintable(teil.body), charset);
  } else if (!teil.headers && sieht_nach_base64_aus(teil.body)) {
    // Kein Header vorhanden, sieht aber eindeutig nach Base64 aus: genau der Fall,
    // in dem „STOP!" als U1RPUCEN… in der Datenbank landete.
    text = Buffer.from(teil.body.replace(/\s+/g, ''), 'base64').toString('utf-8');
  } else if (/=[0-9A-F]{2}/i.test(teil.body)) {
    text = toText(decodeQuotedPrintable(teil.body), charset);
  } else {
    text = teil.body;
  }
  return { text: html ? striptHtml(text) : text, html };
}

/**
 * Holt den lesbaren Klartext aus einem rohen Mail-Body – egal ob Base64,
 * Quoted-Printable, HTML oder mehrteilig.
 *
 * Robust gegen Müll: Was nicht dekodiert werden kann, wird unverändert
 * zurückgegeben. Lieber unschöner Text als gar keiner – nur darf niemals
 * ein kodierter Block als „Inhalt" durchgehen.
 */
export function decodeMailText(raw: string): string {
  if (!raw || !raw.trim()) return '';
  const norm = raw.replace(/\r\n/g, '\n');

  // Mehrteilige Mail: den text/plain-Teil bevorzugen, sonst den HTML-Teil.
  const grenze = norm.match(/boundary\s*=\s*"?([^"\s;]+)"?/i)?.[1]
    ?? norm.match(/^--([-_A-Za-z0-9.]{10,})\s*$/m)?.[1];

  if (grenze) {
    const stuecke = norm.split(new RegExp('--' + grenze.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:--)?\\s*\\n'));
    const kandidaten = stuecke.slice(1).map(s => teilText(trenne(s))).filter(k => k.text.trim());
    const plain = kandidaten.find(k => !k.html);
    const gewaehlt = plain ?? kandidaten[0];
    if (gewaehlt) return aufraeumen(gewaehlt.text);
  }

  return aufraeumen(teilText(trenne(norm)).text);
}

/**
 * Zitierte Vorgeschichte und Signaturtrenner entfernen, Leerraum glätten.
 *
 * Wichtig: erst NACH dem Dekodieren. Vorher würde man Base64-Zeilen zerschneiden
 * und danach ist nichts mehr zu retten.
 */
/**
 * Einzelne Base64-Blöcke mitten im Text auflösen.
 *
 * Bei mehrteiligen Mails bleibt nach dem Entfernen der Trennmarken manchmal ein
 * kodierter Brocken übrig. Genau darin steckte in einem Fall die eigentliche
 * Aussage („Wir arbeiten bereits mit der …") – für uns die wichtigste Information
 * der ganzen Mail, und sie stand als Buchstabensalat in der Datenbank.
 *
 * Nur übernommen, wenn dabei etwas herauskommt, das wie Sprache aussieht.
 */
function loeseBase64Bloecke(text: string): string {
  return text.replace(/[A-Za-z0-9+/]{40,}={0,2}/g, block => {
    try {
      const klar = Buffer.from(block, 'base64').toString('utf-8');
      const lesbar = klar.replace(/[^\p{L}\p{N}\p{P}\p{Zs}\n]/gu, '');
      const sprachlich = /[A-Za-zÄÖÜäöüß]{3,}[\s\p{P}]/u.test(lesbar) && lesbar.length > block.length * 0.4;
      return sprachlich ? lesbar : block;
    } catch { return block; }
  });
}

function aufraeumen(text: string): string {
  return loeseBase64Bloecke(text)
    // Reste von MIME-Kopfzeilen. Bei Altbestand wurden Zeilenumbrüche vor dem
    // Speichern platt gemacht – dann steht „Content-Type: text/plain; charset=…"
    // mitten im Fließtext.
    //
    // Bewusst eng gefasst: nur der Kopfzeilen-Ausdruck selbst, nicht alles bis
    // zum Zeilenende. Eine gierige Variante hat hier die kompletten Antworten
    // ausradiert – aus einer erkannten Absage wurde „unklar". Lieber ein Rest
    // Technik im Text als ein verlorener Inhalt.
    .replace(/--[-_A-Za-z0-9.]{16,}/g, ' ')
    .replace(/Content-Type\s*:\s*[\w./+-]+/gi, ' ')
    .replace(/Content-(Transfer-Encoding|Disposition|ID|Language)\s*:\s*[\w./+-]+/gi, ' ')
    .replace(/;?\s*charset\s*=\s*"?[\w-]+"?/gi, ' ')
    .replace(/;?\s*boundary\s*=\s*"?[^\s";]+"?/gi, ' ')
    .split('\n')
    .filter(l => !l.trimStart().startsWith('>') && !/^-{3,}/.test(l.trim()) && !/^_{3,}/.test(l.trim()))
    .join('\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
