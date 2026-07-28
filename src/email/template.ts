import { getDb } from '../db/schema';

export interface EmailTemplate {
  id: string;
  name: string;
  subject: string;
  body: string;
  category?: string | null;
  updated_at: string;
}

const DEFAULT_SUBJECT = 'Kurze Idee für {name} – KI-Telefonassistent von Tawano';

const DEFAULT_BODY = `Guten Tag {name}-Team,

ich melde mich vom Team Tawano, weil viele {branche}-Betriebe täglich Anrufe verpassen – besonders abends und am Wochenende.

Bei Tawano entwickeln wir KI-Voice-Agenten, die Ihr Telefon rund um die Uhr betreuen:

• Terminanfragen & Rückrufwünsche automatisch aufnehmen
• Häufige Fragen sofort beantworten – ohne Wartezeit
• Nur wichtige Gespräche live an Sie weiterleiten

Testen Sie es gleich selbst – rufen Sie unsere Demo-KI an:
📞 +49 211 86943411

Wäre ein kurzes Gespräch (10 Min.) diese Woche möglich?

Mit freundlichen Grüßen
Tawano – KI-Telefonassistent
www.tawano.de | info@tawano.de`;

export function getEmailTemplate(id = 'default'): EmailTemplate {
  const db = getDb();
  let row = db.prepare('SELECT * FROM email_templates WHERE id = ?').get(id) as EmailTemplate | undefined;
  if (!row) {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT OR IGNORE INTO email_templates (id, name, subject, body, updated_at) VALUES (?, ?, ?, ?, ?)`
    ).run(id, 'Standard Voice Agent', DEFAULT_SUBJECT, DEFAULT_BODY, now);
    row = db.prepare('SELECT * FROM email_templates WHERE id = ?').get(id) as EmailTemplate;
  }
  return row;
}

export function updateEmailTemplate(id: string, data: Partial<Pick<EmailTemplate, 'name' | 'subject' | 'body' | 'category'>>): EmailTemplate {
  const db = getDb();
  // getEmailTemplate legt die Zeile an, falls sie fehlt — danach ist ein reines UPDATE sicher (kein NOT NULL Konflikt).
  const current = getEmailTemplate(id);
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE email_templates SET name = @name, subject = @subject, body = @body, category = @category, updated_at = @now WHERE id = @id`
  ).run({
    id,
    name: data.name ?? current.name,
    subject: data.subject ?? current.subject,
    body: data.body ?? current.body,
    category: data.category !== undefined ? data.category : (current.category ?? null),
    now,
  });
  return getEmailTemplate(id);
}

export function listEmailTemplates(): EmailTemplate[] {
  getEmailTemplate('default'); // stellt sicher, dass mindestens die Standard-Vorlage existiert
  return getDb().prepare('SELECT * FROM email_templates ORDER BY updated_at DESC').all() as EmailTemplate[];
}

export function createEmailTemplate(data: { name: string; subject: string; body: string; category?: string | null }): EmailTemplate {
  const db = getDb();
  const id = 'tpl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  db.prepare(
    `INSERT INTO email_templates (id, name, subject, body, category, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, data.name || 'Neue Vorlage', data.subject || '', data.body || '', data.category ?? null, new Date().toISOString());
  return db.prepare('SELECT * FROM email_templates WHERE id = ?').get(id) as EmailTemplate;
}

export function deleteEmailTemplate(id: string): void {
  if (id === 'default') throw new Error('Die Standard-Vorlage kann nicht gelöscht werden');
  getDb().prepare('DELETE FROM email_templates WHERE id = ?').run(id);
}

export function getTemplateById(id: string): EmailTemplate | undefined {
  return getDb().prepare('SELECT * FROM email_templates WHERE id = ?').get(id) as EmailTemplate | undefined;
}

// Fertige Follow-up-Vorlagen, damit im manuellen Follow-up-Versand sofort gute Copy bereitsteht.
// Idempotent: legt nur an, was fehlt (überschreibt keine vom Nutzer bearbeiteten Vorlagen).
const FOLLOWUP_TEMPLATES: Array<{ id: string; name: string; subject: string; body: string }> = [
  {
    id: 'fu-bump',
    name: 'Follow-up 1 – Nachfrage',
    subject: 'Kurze Nachfrage, {name}',
    body: `Guten Tag {name}-Team,

ich wollte kurz nachhaken, ob meine letzte Nachricht bei Ihnen angekommen ist.

Viele {branche}-Betriebe verpassen täglich Anrufe – unser KI-Telefonassistent nimmt sie rund um die Uhr entgegen, bucht Termine und leitet nur die wichtigen Gespräche an Sie weiter.

Testen Sie die Demo-KI direkt: +49 211 86943411

Reicht Ihnen ein kurzer Anruf (10 Min.) diese Woche? Antworten Sie einfach auf diese E-Mail.

Mit freundlichen Grüßen
Tawano – KI-Telefonassistent
www.tawano.de | info@tawano.de`,
  },
  {
    id: 'fu-breakup',
    name: 'Follow-up 2 – Letzter Versuch',
    subject: 'Letzter Versuch – {name}',
    body: `Guten Tag {name}-Team,

ich möchte Ihnen nicht weiter schreiben, wenn das Thema gerade nicht passt – das ist völlig in Ordnung.

Falls verpasste Anrufe bei Ihnen aber ein Thema sind: Unser KI-Assistent nimmt sie 24/7 an, bucht Termine und beantwortet Standardfragen. Schon ein paar zusätzlich angenommene Anrufe pro Woche rechnen sich.

Wenn ich Ihnen die 3 wichtigsten Vorteile in 10 Minuten zeigen darf, antworten Sie einfach mit „Ja".
Andernfalls wünsche ich Ihnen weiterhin viel Erfolg.

Mit freundlichen Grüßen
Tawano – KI-Telefonassistent
www.tawano.de | info@tawano.de`,
  },
];

export function seedFollowupTemplates(): void {
  const db = getDb();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO email_templates (id, name, subject, body, category, updated_at) VALUES (?, ?, ?, ?, 'Follow-up', ?)`
  );
  const now = new Date().toISOString();
  for (const t of FOLLOWUP_TEMPLATES) insert.run(t.id, t.name, t.subject, t.body, now);
}

// Kanonische Demo-Nummer (an einer Stelle, damit alle Vorlagen konsistent bleiben).
export const DEMO_PHONE = '+49 211 86943411';

// Erstkontakt-Varianten für die A/B-Rotation im Auto-Versand.
// Unterschiedliche Betreffzeilen + Winkel senken das Spam-Risiko (keine identischen Massenmails)
// und zeigen, welche Ansprache zieht. Alle branchenagnostisch über {branche}/{stadt}/{name}.
export const OUTREACH_TEMPLATE_IDS = ['default', 'outreach-b', 'outreach-c'];

const OUTREACH_VARIANTS: Array<{ id: string; name: string; subject: string; body: string }> = [
  {
    id: 'outreach-b',
    name: 'Erstkontakt B – Umsatz-Winkel',
    subject: 'Verpasste Anrufe = verlorene Aufträge, {name}?',
    body: `Guten Tag {name}-Team,

bei {branche}-Betrieben in {stadt} ist es oft dasselbe Bild: Das Telefon klingelt, alle sind im Einsatz, der Anrufer legt nach ein paar Klingeln auf – und ruft beim Nächsten an. Der Auftrag ist weg.

Ich baue automatische Telefonassistenten, die genau das auffangen: jeden Anruf entgegennehmen, Anliegen und Rückrufwunsch aufnehmen und Sie sofort informieren – auch abends und am Wochenende.

Sie können einmal selbst hören, wie natürlich das klingt: ${DEMO_PHONE}

Wäre ein kurzer Austausch (10 Min.) diese Woche einen Blick wert?

Viele Grüße
Max – Tawano
www.tawano.de | info@tawano.de`,
  },
  {
    id: 'outreach-c',
    name: 'Erstkontakt C – Kurz & direkt',
    subject: 'Kurze Frage zu Ihrer Erreichbarkeit, {name}',
    body: `Guten Tag {name}-Team,

kurze Frage: Wie viele Anrufe gehen bei Ihnen täglich verloren, weil gerade niemand rangehen kann?

Ich baue automatische Telefonassistenten für {branche}-Betriebe in {stadt} – der Assistent geht jederzeit ran, nimmt das Anliegen auf und benachrichtigt Sie sofort. Klingt wie ein echtes Gespräch, nicht wie ein Roboter.

Einmal selbst testen: ${DEMO_PHONE}

Passt ein kurzes Gespräch (10 Min.) diese Woche?

Viele Grüße
Max – Tawano
www.tawano.de | info@tawano.de`,
  },
];

/**
 * Repariert die (in Alt-Installationen) beschädigte Standard-Vorlage und legt die
 * Erstkontakt-Varianten an. Idempotent, überschreibt keine gesunden Nutzer-Edits:
 * - 'default' wird nur überschrieben, wenn es die bekannten Defekt-Marker enthält
 *   (nicht ersetzter Platzhalter {Firmenname} oder doppeltes Komma ",,").
 * - Varianten werden per INSERT OR IGNORE nur angelegt, wenn sie fehlen.
 */
export function seedOutreachTemplates(): void {
  const db = getDb();
  const now = new Date().toISOString();

  // Standard-Vorlage sicherstellen + ggf. reparieren.
  const def = getEmailTemplate('default');
  const corrupted = /\{Firmenname\}/.test(def.body) || /,,/.test(def.body) || /\{Firmenname\}/.test(def.subject);
  if (corrupted) {
    db.prepare(`UPDATE email_templates SET subject = @s, body = @b, updated_at = @now WHERE id = 'default'`)
      .run({ s: DEFAULT_SUBJECT, b: DEFAULT_BODY, now });
  }

  const insert = db.prepare(
    `INSERT OR IGNORE INTO email_templates (id, name, subject, body, category, updated_at) VALUES (?, ?, ?, ?, 'Erstkontakt', ?)`
  );
  for (const t of OUTREACH_VARIANTS) {
    insert.run(t.id, t.name, t.subject, t.body, now);
  }

  // Demo-Nummer in ALLEN Vorlagen auf die kanonische Nummer normalisieren – fängt
  // bereits geseedete Zeilen mit veralteter Nummer ab (lokal wie auf Prod), da
  // INSERT OR IGNORE bestehende Zeilen sonst nie aktualisiert.
  const OLD_DEMO_NUMBERS = ['+49 211 86943717', '+4921186943411'];
  for (const old of OLD_DEMO_NUMBERS) {
    if (old === DEMO_PHONE) continue;
    db.prepare(
      `UPDATE email_templates
       SET body = REPLACE(body, @old, @new), subject = REPLACE(subject, @old, @new), updated_at = @now
       WHERE body LIKE @like OR subject LIKE @like`
    ).run({ old, new: DEMO_PHONE, now, like: '%' + old + '%' });
  }
}

export function renderTemplate(
  tmpl: EmailTemplate,
  vars: { name: string; branche?: string; stadt?: string }
): { subject: string; body: string } {
  const r = (s: string) =>
    s.replace(/\{name\}/g, vars.name || '')
     .replace(/\{branche\}/g, vars.branche || '')
     .replace(/\{stadt\}/g, vars.stadt || '');
  return { subject: r(tmpl.subject), body: r(tmpl.body) };
}
