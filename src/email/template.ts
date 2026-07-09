import { getDb } from '../db/schema';

export interface EmailTemplate {
  id: string;
  name: string;
  subject: string;
  body: string;
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
📞 +49 211 86943717

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

export function updateEmailTemplate(id: string, data: Partial<Pick<EmailTemplate, 'name' | 'subject' | 'body'>>): EmailTemplate {
  const db = getDb();
  // getEmailTemplate legt die Zeile an, falls sie fehlt — danach ist ein reines UPDATE sicher (kein NOT NULL Konflikt).
  const current = getEmailTemplate(id);
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE email_templates SET name = @name, subject = @subject, body = @body, updated_at = @now WHERE id = @id`
  ).run({
    id,
    name: data.name ?? current.name,
    subject: data.subject ?? current.subject,
    body: data.body ?? current.body,
    now,
  });
  return getEmailTemplate(id);
}

export function listEmailTemplates(): EmailTemplate[] {
  getEmailTemplate('default'); // stellt sicher, dass mindestens die Standard-Vorlage existiert
  return getDb().prepare('SELECT * FROM email_templates ORDER BY updated_at DESC').all() as EmailTemplate[];
}

export function createEmailTemplate(data: { name: string; subject: string; body: string }): EmailTemplate {
  const db = getDb();
  const id = 'tpl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  db.prepare(
    `INSERT INTO email_templates (id, name, subject, body, updated_at) VALUES (?, ?, ?, ?, ?)`
  ).run(id, data.name || 'Neue Vorlage', data.subject || '', data.body || '', new Date().toISOString());
  return db.prepare('SELECT * FROM email_templates WHERE id = ?').get(id) as EmailTemplate;
}

export function deleteEmailTemplate(id: string): void {
  if (id === 'default') throw new Error('Die Standard-Vorlage kann nicht gelöscht werden');
  getDb().prepare('DELETE FROM email_templates WHERE id = ?').run(id);
}

export function getTemplateById(id: string): EmailTemplate | undefined {
  return getDb().prepare('SELECT * FROM email_templates WHERE id = ?').get(id) as EmailTemplate | undefined;
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
