import { getDb } from '../db/schema';

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
    body: `{gruss},

ich wollte kurz nachhaken, ob meine letzte Nachricht bei Ihnen angekommen ist.

Kurz zur Erinnerung: Unser KI-Telefonassistent nimmt verpasste Anrufe rund um die Uhr an, bucht Termine und leitet nur die wichtigen Gespräche an Sie weiter – ohne Mehraufwand für Sie.

Selbst anhören: +49 211 86943411

Wenn ein kurzes Gespräch (10 Min.) für Sie passt, antworten Sie einfach mit „Ja" – ich schicke Ihnen zwei Terminvorschläge. Falls nicht, kein Problem.

Mit freundlichen Grüßen
Tawano
www.tawano.de | info@tawano.de`,
  },
  {
    id: 'fu-breakup',
    name: 'Follow-up 2 – Letzter Versuch',
    subject: 'Letzter Versuch – {name}',
    body: `{gruss},

ich möchte Ihnen nicht weiter schreiben, wenn das Thema gerade nicht passt – das ist völlig in Ordnung.

Falls verpasste Anrufe bei Ihnen aber ein Thema sind: Unser KI-Assistent nimmt sie 24/7 an, bucht Termine und beantwortet Standardfragen. Schon ein paar zusätzlich angenommene Anrufe pro Woche rechnen sich.

Wenn ich Ihnen die 3 wichtigsten Vorteile in 10 Minuten zeigen darf, antworten Sie einfach mit „Ja". Andernfalls wünsche ich Ihnen weiterhin viel Erfolg.

Mit freundlichen Grüßen
Tawano
www.tawano.de | info@tawano.de`,
  },
];

// Hebt eine systemeigene Vorlage auf die neue Copy – aber nur solange die Zeile
// noch die alte, unbearbeitete Begrüßung "{name}-Team" enthält. So bekommen
// bestehende Installationen die verbesserten Texte automatisch, während vom
// Nutzer im Dashboard bearbeitete Vorlagen unangetastet bleiben. Idempotent.
function upgradeStaleTemplate(id: string, subject: string, body: string, now: string): void {
  getDb().prepare(
    `UPDATE email_templates SET subject = @subject, body = @body, updated_at = @now
     WHERE id = @id AND body LIKE '%{name}-Team%'`
  ).run({ id, subject, body, now });
}

export function seedFollowupTemplates(): void {
  const db = getDb();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO email_templates (id, name, subject, body, category, updated_at) VALUES (?, ?, ?, ?, 'Follow-up', ?)`
  );
  const now = new Date().toISOString();
  for (const t of FOLLOWUP_TEMPLATES) {
    insert.run(t.id, t.name, t.subject, t.body, now);
    upgradeStaleTemplate(t.id, t.subject, t.body, now);
  }
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
    body: `{gruss},

bei {branche}-Betrieben in {stadt} ist es oft dasselbe Bild: Das Telefon klingelt, alle sind im Einsatz, der Anrufer legt nach ein paar Klingeln auf – und ruft beim Nächsten an. Der Auftrag ist weg.

Ich baue KI-Telefonassistenten, die genau das auffangen: jeden Anruf annehmen, Anliegen und Rückrufwunsch aufnehmen und Sie sofort informieren – auch abends und am Wochenende.

Hören Sie einmal selbst, wie natürlich das klingt: ${DEMO_PHONE}

Klingt das interessant? Dann antworten Sie einfach mit „Ja" – ich melde mich mit zwei Terminvorschlägen (10 Min.). Falls nicht, kein Problem.

Viele Grüße
Tawano
www.tawano.de | info@tawano.de`,
  },
  {
    id: 'outreach-c',
    name: 'Erstkontakt C – Kurz & direkt',
    subject: 'Kurze Frage zu Ihrer Erreichbarkeit, {name}',
    body: `{gruss},

kurze Frage: Wie viele Anrufe gehen bei Ihnen pro Woche verloren, weil gerade niemand rangehen kann?

Ich baue KI-Telefonassistenten für {branche}-Betriebe in {stadt} – der Assistent geht jederzeit ran, nimmt das Anliegen auf und benachrichtigt Sie sofort. Klingt wie ein echtes Gespräch, nicht wie ein Roboter.

Einmal selbst testen: ${DEMO_PHONE}

Wenn Sie das kurz besprechen möchten, antworten Sie einfach mit „Ja". Falls nicht, kein Problem.

Viele Grüße
Tawano
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

  // Standard-Vorlage von der alten "{name}-Team"-Copy auf die neue heben.
  upgradeStaleTemplate('default', DEFAULT_SUBJECT, DEFAULT_BODY, now);

  const insert = db.prepare(
    `INSERT OR IGNORE INTO email_templates (id, name, subject, body, category, updated_at) VALUES (?, ?, ?, ?, 'Erstkontakt', ?)`
  );
  for (const t of OUTREACH_VARIANTS) {
    insert.run(t.id, t.name, t.subject, t.body, now);
    upgradeStaleTemplate(t.id, t.subject, t.body, now);
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
  vars: { name: string; branche?: string; stadt?: string; ansprechpartner?: string }
): { subject: string; body: string } {
  const gruss = buildGruss(vars.ansprechpartner);
  const r = (s: string) =>
    s.replace(/\{gruss\}/g, gruss)
     .replace(/\{name\}/g, vars.name || '')
     .replace(/\{branche\}/g, vars.branche || '')
     .replace(/\{stadt\}/g, vars.stadt || '');
  return { subject: r(tmpl.subject), body: r(tmpl.body) };
}

// ── CONSULT-Outreach ─────────────────────────────────────────────────────────
// Anderes Angebot als der Tawano-Voice-Agent: hier positioniert sich Tawano als
// KI-Automatisierer, der wiederkehrende Büroarbeit wegautomatisiert. Aufhänger ist
// bewusst generischer Social Proof (mehrere Betriebe, kein konkretes Beispiel und
// keine Preiszahl) – das vermeidet „passt nicht zu meiner Branche" und erzeugt eine
// Neugier-Lücke, die im Gespräch nachgefragt wird. Absender = Marke Tawano, Link auf
// die Startseite (NICHT die Voice-Agent-Seite). Zielbranchen: Immobilienmakler,
// Autohäuser, Steuerberater. Kategorie 'Consult' → separat filterbar, eigener Send-Job.
const CONSULT_VARIANTS: Array<{ id: string; name: string; subject: string; body: string }> = [
  {
    id: 'consult-immo',
    name: 'Consult – Immobilienmakler',
    subject: 'Mehr Zeit fürs Verkaufen, {name}?',
    body: `{gruss},

in fast jedem Maklerbüro frisst wiederkehrende Handarbeit täglich Stunden – Zeit, die für Verkauf und Kunden fehlt.

Genau da komme ich ins Spiel: Ich finde die Abläufe, die Sie jeden Monat unnötig Zeit und Geld kosten, und automatisiere sie mit KI – Schritt für Schritt, messbar und ohne Ihren laufenden Betrieb zu stören.

Für bereits vier Betriebe habe ich Abläufe, die vorher richtig viel Zeit gefressen haben, komplett automatisiert – und Prozesse aufgesetzt, die es dort vorher gar nicht gab. Gezielt auf den jeweiligen Betrieb zugeschnitten; andere verlangen dafür ein Vielfaches.

Mein Vorschlag: In 15 Minuten schaue ich mir Ihre Abläufe an und baue die erste Automatisierung kostenlos. Spart sie Ihnen messbar Zeit, reden wir weiter.

Falls Sie selbst schon konkrete Abläufe im Kopf haben, die Sie gern automatisieren würden, sprechen wir direkt darüber.

Passt das? Dann antworten Sie einfach mit „Ja" – ich schicke Ihnen zwei Terminvorschläge. Falls nicht, kein Problem.

Mit freundlichen Grüßen
Tawano
www.tawano.de`,
  },
  {
    id: 'consult-auto',
    name: 'Consult – Autohäuser',
    subject: 'Weniger Handarbeit im Autohaus, {name}?',
    body: `{gruss},

in vielen Autohäusern läuft ein großer Teil des Tagesgeschäfts noch von Hand – das kostet jeden Monat Zeit und Umsatz.

Genau da komme ich ins Spiel: Ich finde die Abläufe, die Sie jeden Monat unnötig Zeit und Geld kosten, und automatisiere sie mit KI – Schritt für Schritt, messbar und ohne Ihren laufenden Betrieb zu stören.

Für bereits vier Betriebe habe ich Abläufe, die vorher richtig viel Zeit gefressen haben, komplett automatisiert – und Prozesse aufgesetzt, die es dort vorher gar nicht gab. Gezielt auf den jeweiligen Betrieb zugeschnitten; andere verlangen dafür ein Vielfaches.

Mein Vorschlag: In 15 Minuten schaue ich mir Ihre Abläufe an und baue die erste Automatisierung kostenlos. Spart sie Ihnen messbar Zeit, reden wir weiter.

Falls Sie selbst schon konkrete Abläufe im Kopf haben, die Sie gern automatisieren würden, sprechen wir direkt darüber.

Passt das? Dann antworten Sie einfach mit „Ja" – ich schicke Ihnen zwei Terminvorschläge. Falls nicht, kein Problem.

Mit freundlichen Grüßen
Tawano
www.tawano.de`,
  },
  {
    id: 'consult-steuer',
    name: 'Consult – Steuerberater',
    subject: 'Weniger Papierkram in der Kanzlei, {name}?',
    body: `{gruss},

in vielen Kanzleien bindet wiederkehrende Handarbeit jeden Monat wertvolle Stunden – Belege nachfassen, Fristen im Blick behalten, immer dieselben E-Mails.

Genau da komme ich ins Spiel: Ich finde die Abläufe, die Ihrer Kanzlei jeden Monat unnötig Zeit und Geld kosten, und automatisiere sie mit KI – Schritt für Schritt, messbar und ohne Ihren laufenden Betrieb zu stören.

Für bereits vier Betriebe habe ich Abläufe, die vorher richtig viel Zeit gefressen haben, komplett automatisiert – und Prozesse aufgesetzt, die es dort vorher gar nicht gab. Gezielt auf den jeweiligen Betrieb zugeschnitten; andere verlangen dafür ein Vielfaches.

Mein Vorschlag: In 15 Minuten schaue ich mir Ihre Abläufe an und baue die erste Automatisierung kostenlos. Spart sie Ihnen messbar Zeit, reden wir weiter.

Falls Sie selbst schon konkrete Abläufe im Kopf haben, die Sie gern automatisieren würden, sprechen wir direkt darüber.

Passt das? Dann antworten Sie einfach mit „Ja" – ich schicke Ihnen zwei Terminvorschläge. Falls nicht, kein Problem.

Mit freundlichen Grüßen
Tawano
www.tawano.de`,
  },
];

/**
 * Legt die Consult-Outreach-Vorlagen an (Kategorie 'Consult'). INSERT OR IGNORE:
 * überschreibt vom Nutzer bearbeitete Vorlagen nicht. Wird beim Serverstart neben
 * seedOutreachTemplates aufgerufen.
 */
export function seedConsultTemplates(): void {
  const db = getDb();
  const now = new Date().toISOString();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO email_templates (id, name, subject, body, category, updated_at) VALUES (?, ?, ?, ?, 'Consult', ?)`
  );
  for (const t of CONSULT_VARIANTS) {
    insert.run(t.id, t.name, t.subject, t.body, now);
    upgradeStaleTemplate(t.id, t.subject, t.body, now);
  }
}
