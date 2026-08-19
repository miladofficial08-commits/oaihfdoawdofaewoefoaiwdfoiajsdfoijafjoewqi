import { getDb } from '../db/schema';
import { retargetTemplateName } from '../workflow/schema';
import { Lead } from '../types';
import { personalLine, applyPersonalLine, upgradeAnrede } from './personal-line';

export interface EmailTemplate {
  id: string;
  name: string;
  subject: string;
  body: string;
  category?: string | null;
  updated_at: string;
}

const DEFAULT_SUBJECT = 'Nehmen Sie jeden Anruf an, {name}?';

const DEFAULT_BODY = `{gruss},

kurz und ehrlich: Die meisten {branche}-Betriebe verlieren jede Woche Aufträge, weil das Telefon klingelt, während alle im Einsatz sind – der Anrufer legt auf und ruft beim Nächsten an.

Ich baue KI-Telefonassistenten, die genau das verhindern: Sie nehmen jeden Anruf rund um die Uhr an, notieren Anliegen und Rückrufwunsch und leiten nur die wichtigen Gespräche live an Sie weiter.

Hören Sie einfach selbst, wie natürlich das klingt – rufen Sie unsere Demo an: +49 211 86943411

Wenn das interessant für Sie ist, antworten Sie einfach mit „Ja" – ich schicke Ihnen zwei Terminvorschläge für ein kurzes Gespräch (10 Min.). Falls nicht, kein Problem.

Mit freundlichen Grüßen
Tawano
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

export function updateEmailTemplate(
  id: string,
  data: Partial<Pick<EmailTemplate, 'name' | 'subject' | 'body' | 'category'>>
): EmailTemplate & { strategie_mitgezogen: string[] } {
  const db = getDb();
  // getEmailTemplate legt die Zeile an, falls sie fehlt — danach ist ein reines UPDATE sicher (kein NOT NULL Konflikt).
  const current = getEmailTemplate(id);
  const now = new Date().toISOString();
  const subject = data.subject ?? current.subject;
  // Der Name ist kein zweites Feld zum Ausdenken: Wer ihn leer laesst, bekommt den
  // Betreff als Namen. Ein Betreff beschreibt die Mail ohnehin am besten.
  const name = nameOderBetreff(data.name !== undefined ? data.name : current.name, subject);

  db.prepare(
    `UPDATE email_templates SET name = @name, subject = @subject, body = @body, category = @category, updated_at = @now WHERE id = @id`
  ).run({
    id,
    name,
    subject,
    body: data.body ?? current.body,
    category: data.category !== undefined ? data.category : (current.category ?? null),
    now,
  });

  // Haengt die Strategie an dieser Vorlage, wird sie mit umbenannt – sonst faellt
  // genau diese Mail nach dem Umbenennen still aus.
  const mitgezogen = name !== current.name ? retargetTemplateName(current.name, name) : [];

  return { ...getEmailTemplate(id), strategie_mitgezogen: mitgezogen };
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
  ).run(id, nameOderBetreff(data.name, data.subject), data.subject || '', data.body || '', data.category ?? null, new Date().toISOString());
  return db.prepare('SELECT * FROM email_templates WHERE id = ?').get(id) as EmailTemplate;
}

/**
 * Der Name einer Vorlage ist optional.
 *
 * Sich zusätzlich zum Betreff einen Namen auszudenken ist doppelte Arbeit für
 * dieselbe Sache. Bleibt das Feld leer, ist der Betreff der Name – der beschreibt
 * die Mail ohnehin am genauesten.
 */
function nameOderBetreff(name: string | undefined, subject: string | undefined): string {
  const n = (name || '').trim();
  if (n) return n;
  const s = (subject || '').trim();
  return s ? s.slice(0, 120) : 'Neue Vorlage';
}

export function deleteEmailTemplate(id: string): void {
  if (id === 'default') throw new Error('Die Standard-Vorlage kann nicht gelöscht werden');
  getDb().prepare('DELETE FROM email_templates WHERE id = ?').run(id);
}

export function getTemplateById(id: string): EmailTemplate | undefined {
  return getDb().prepare('SELECT * FROM email_templates WHERE id = ?').get(id) as EmailTemplate | undefined;
}

// Das System legt KEINE Vorlagen mehr an. Frueher standen hier fertige Texte,
// die beim Start per INSERT OR IGNORE nachgesaet wurden – wer sie loeschte,
// hatte sie beim naechsten Start wieder da. Es gilt nur noch der eigene Bestand
// des Nutzers; das Aufraeumen steht in template-cleanup.ts.

// Persönliche Anrede aus dem Geschäftsführer bauen. Nur nutzen, wenn es
// plausibel ein Name ist (keine Ziffern/@/URL, sinnvolle Länge) – sonst sauberer
// Fallback auf "Guten Tag", damit nie "Guten Tag ," oder Impressum-Müll rausgeht.
function buildGruss(ansprechpartner?: string): string {
  const raw = (ansprechpartner || '').trim();
  const plausible =
    raw.length >= 3 &&
    raw.length <= 40 &&
    /^[A-Za-zÄÖÜäöüß.\- ]+$/.test(raw) &&
    /\p{L}\p{L}/u.test(raw);
  return plausible ? `Guten Tag ${raw}` : 'Guten Tag';
}

export function renderTemplate(
  tmpl: EmailTemplate,
  vars: { name: string; branche?: string; stadt?: string; ansprechpartner?: string; lead?: Lead }
): { subject: string; body: string } {
  const gruss = buildGruss(vars.ansprechpartner);
  const r = (s: string) =>
    s.replace(/\{gruss\}/g, gruss)
     .replace(/\{name\}/g, vars.name || '')
     .replace(/\{branche\}/g, vars.branche || '')
     .replace(/\{stadt\}/g, vars.stadt || '');

  // Der personalisierte Satz kommt NACH dem Ersetzen: Er soll den Text des
  // Nutzers ergänzen, nicht selbst durch die Platzhalter-Mühle laufen.
  let body = r(tmpl.body);
  // Fest getippte Anrede auf den bekannten Namen anheben, dann personalisieren.
  body = upgradeAnrede(body, gruss);
  if (vars.lead) body = applyPersonalLine(body, personalLine(vars.lead));
  return { subject: r(tmpl.subject), body };
}

/** IDs der alten A/B-Rotation. Bleibt fuer den abgeschalteten Tagesmotor stehen. */
export const OUTREACH_TEMPLATE_IDS = ['default', 'outreach-b', 'outreach-c'];


/**
 * Findet eine Vorlage über einen Teil ihres Namens.
 *
 * Der Nutzer benennt seine Vorlagen selbst („Anruf um 17:40 Uhr", „verpasster
 * Anruf"). Deren interne IDs kennt der Graph nicht – und soll er auch nicht,
 * sonst bricht die Strategie, sobald jemand eine Vorlage neu anlegt. Deshalb
 * verweist der Graph auf den NAMEN, und diese Funktion löst ihn auf.
 * Vergleich bewusst tolerant: Groß-/Kleinschreibung und Umlaute egal.
 */
export function findTemplateByName(fragment: string): EmailTemplate | undefined {
  const norm = (s: string) => (s || '').toLowerCase()
    .replace(/[äöüß]/g, m => ({ 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'ß': 'ss' }[m] || m))
    .replace(/[^a-z0-9]+/g, ' ').trim();
  const ziel = norm(fragment);
  if (!ziel) return undefined;
  const alle = getDb().prepare('SELECT * FROM email_templates').all() as EmailTemplate[];
  // Exakter Name gewinnt, sonst der erste Treffer, der den Text enthält.
  return alle.find(t => norm(t.name) === ziel)
      ?? alle.find(t => norm(t.name).includes(ziel))
      ?? alle.find(t => norm(t.subject).includes(ziel));
}
