import { getDb } from '../db/schema';
import { Workflow, effectiveDailyCap, getSetting, activeWorkflows } from './schema';
import { pendingCount } from './enroll';
import { findTemplateByName } from '../email/template';

// ─────────────────────────────────────────────────────────────────────────────
// Wächter über die E-Mail-Abteilung.
//
// Wer sich aufs Telefonieren konzentriert, merkt nicht, wenn die Maschine still
// steht. Genau das ist der teuerste Fehlerfall: Es sieht alles normal aus, aber
// seit zwei Tagen geht nichts raus. Diese Datei beantwortet eine Frage:
//
//   Läuft die E-Mail-Abteilung gerade – und wenn nicht, warum?
//
// Bewusst ehrlich: Wenn etwas fehlt (Postfach nicht angebunden, keine Leads,
// Konto gesperrt), steht das im Klartext da, statt dass eine grüne Kachel lügt.
// ─────────────────────────────────────────────────────────────────────────────

export type HealthLevel = 'ok' | 'warn' | 'down' | 'off';

export interface HealthLine {
  level: HealthLevel;
  text: string;
}

export interface HealthReport {
  level: HealthLevel;
  headline: string;
  lines: HealthLine[];
  sent_today: number;
  cap_today: number;
  last_send_at: string | null;
  hours_since_send: number | null;
  pending: number;
  active_runs: number;
  reichweite_tage: number | null;
}

const hoursSince = (iso: string | null): number | null => {
  if (!iso) return null;
  const t = new Date(String(iso).replace(' ', 'T') + (/[Z+]/.test(String(iso)) ? '' : 'Z')).getTime();
  return Number.isFinite(t) ? Math.round((Date.now() - t) / 3_600_000) : null;
};

/**
 * Die Strategie sucht ihre Vorlagen ueber den Namen. Wird eine nicht gefunden,
 * faellt genau diese Mail lautlos aus und der Lead verliert eine Stufe. Deshalb
 * pruefen wir das auch dann, wenn die Strategie noch gar nicht laeuft – der
 * richtige Moment fuer diese Warnung ist VOR dem Uebernehmen.
 */
function fehlendeVorlagen(wf: Workflow): HealthLine | null {
  const fehlend = new Set<string>();
  for (const n of wf.graph.nodes) {
    if (n.type !== 'email') continue;
    const cfg = n.config as { template_match?: unknown; template_id?: string };
    const roh = cfg.template_match;
    const namen = Array.isArray(roh) ? roh.map(String) : roh ? [String(roh)] : [];
    // Gar keine Vorlage hinterlegt ist genauso schlimm wie eine falsch benannte.
    if (!namen.length && !cfg.template_id) { fehlend.add(`${n.title} (keine Vorlage gewaehlt)`); continue; }
    for (const name of namen) if (!findTemplateByName(name)) fehlend.add(name);
  }
  if (!fehlend.size) return null;
  return {
    level: 'down',
    text: `Diese Vorlagen findet die Strategie nicht: ${[...fehlend].join(', ')}. `
        + 'Entweder heissen sie unter „Vorlagen" anders, oder sie fehlen. '
        + 'Solange das so ist, faellt genau diese Mail aus.',
  };
}

/**
 * Alles, was VOR dem ersten Versand stimmen muss. Bewusst getrennt von den
 * Laufzeit-Pruefungen: Diese Punkte gelten auch (und gerade) dann, wenn die
 * Strategie noch aus ist. Vorher brach der Waechter im Aus-Zustand frueh ab und
 * verschwieg genau die Fragen, die man vor dem Start beantwortet haben will.
 */
export function startklarLinien(wf: Workflow): HealthLine[] {
  const db = getDb();
  const raus: HealthLine[] = [];
  const one = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n;

  // Vorlagen: haengt jede Mail des Baums an einer Vorlage, die es gibt?
  const fehlt = fehlendeVorlagen(wf);
  if (fehlt) raus.push(fehlt);
  else raus.push({ level: 'ok', text: 'Vorlagen: jede Mail im Baum haengt an einer vorhandenen Vorlage.' });

  // Postfach: ohne IMAP werden Antworten und Abmeldungen nicht erkannt.
  const inboxOk = Boolean((process.env.IMAP_USER || process.env.SMTP_USER) && (process.env.IMAP_PASS || process.env.SMTP_PASS));
  raus.push(inboxOk
    ? { level: 'ok', text: 'Postfach angebunden: Antworten und Abmeldungen werden erkannt.' }
    : { level: 'down', text: 'Postfach NICHT angebunden. Antworten werden nicht erkannt – Interessenten gehen verloren und Abmeldungen greifen nicht.' });

  // Versandweg: ohne SMTP/Brevo geht ueberhaupt nichts raus.
  const sendenOk = Boolean(process.env.BREVO_API_KEY || (process.env.SMTP_HOST && process.env.SMTP_USER));
  raus.push(sendenOk
    ? { level: 'ok', text: `Versandweg steht (${process.env.SMTP_FROM || 'Absender nicht gesetzt'}).` }
    : { level: 'down', text: 'Kein Versandweg: weder Brevo-Schluessel noch SMTP-Zugang gesetzt.' });

  // Termin-Link: ohne ihn wird aus Interesse nur eine Aufgabe statt einer Mail.
  raus.push(getSetting('cal_link', '').trim()
    ? { level: 'ok', text: 'Termin-Link hinterlegt: Bei Interesse geht die Terminmail automatisch raus.' }
    : { level: 'warn', text: 'Kein Cal.com-Link hinterlegt: Bei Interesse entsteht nur eine Aufgabe, keine Terminmail. Unten unter den Einstellungen eintragen.' });

  // Nahrung: gibt es ueberhaupt Firmen zum Anschreiben?
  const wartend = wf.graph.nodes
    .filter(n => n.type === 'trigger')
    .reduce((sum, n) => { try { return sum + pendingCount(wf, n); } catch { return sum; } }, 0);
  const drin = one(`SELECT COUNT(*) n FROM workflow_runs WHERE workflow_id = ? AND status = 'active'`, wf.id);
  raus.push((wartend + drin) > 0
    ? { level: 'ok', text: `Vorrat: ${drin} Firmen bereits in der Strategie, ${wartend} warten auf Aufnahme.` }
    : { level: 'down', text: 'Keine Firmen zum Anschreiben: weder in der Strategie noch in der Warteschlange. Erst Leads holen oder „Bestandsdaten einsortieren" druecken.' });

  // Bereits angeschriebene Firmen, die in keiner Stage stehen.
  const verwaist = db.prepare(
    `SELECT COALESCE(l.track,'voice_agent') AS track, COUNT(*) AS n
     FROM leads l
     WHERE l.email IS NOT NULL AND l.email != ''
       AND LOWER(TRIM(l.email)) IN (SELECT LOWER(TRIM(to_email)) FROM sent_emails WHERE success = 1)
       AND l.id NOT IN (SELECT lead_id FROM workflow_runs WHERE status = 'active')
       AND COALESCE(l.status,'') != 'duplicate'
     GROUP BY COALESCE(l.track,'voice_agent')`
  ).all() as Array<{ track: string; n: number }>;
  for (const v of verwaist) {
    if (v.n <= 0) continue;
    raus.push({
      level: 'warn',
      text: v.track === wf.track
        ? `${v.n} bereits angeschriebene Firmen stehen in keiner Stage – auf „Bestandsdaten einsortieren" druecken, sonst faellt niemand nach.`
        : `${v.n} angeschriebene Firmen im Bereich „${v.track}" laufen in keiner Strategie. Dafuer braucht es eine eigene Strategie mit diesem Track.`,
    });
  }

  // Altsysteme, die parallel senden wuerden.
  const alteJobs = one(`SELECT COUNT(*) n FROM send_jobs WHERE status = 'running'`);
  if (alteJobs > 0) raus.push({ level: 'down', text: `${alteJobs} alte Auto-Kampagne(n) laufen noch. Dieselben Firmen bekaemen Post aus zwei Systemen – erst stoppen.` });
  const fuOn = (db.prepare(`SELECT enabled FROM followup_config WHERE id = 1`).get() as { enabled: number } | undefined)?.enabled === 1;
  if (fuOn) raus.push({ level: 'warn', text: 'Der alte Follow-up-Worker ist noch aktiv. Die Strategie fasst selbst nach – beim Uebernehmen wird er gestoppt.' });
  if (alteJobs === 0 && !fuOn) raus.push({ level: 'ok', text: 'Keine Altkampagne laeuft parallel.' });

  return raus;
}

export function workflowHealth(wf: Workflow): HealthReport {
  const db = getDb();
  const lines: HealthLine[] = [];
  const one = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n;

  const sentToday = one(
    `SELECT COUNT(*) n FROM sent_emails WHERE success = 1 AND campaign LIKE 'wf-%'
     AND sent_at >= datetime('now','start of day','localtime')`
  );
  const lastSend = (db.prepare(
    `SELECT MAX(sent_at) t FROM sent_emails WHERE success = 1 AND campaign LIKE 'wf-%'`
  ).get() as { t: string | null }).t;
  const failedRecently = one(
    `SELECT COUNT(*) n FROM sent_emails WHERE success = 0 AND campaign LIKE 'wf-%'
     AND sent_at >= datetime('now','-1 day')`
  );
  const activeRuns = one(`SELECT COUNT(*) n FROM workflow_runs WHERE workflow_id = ? AND status = 'active'`, wf.id);
  const dueRuns = one(
    `SELECT COUNT(*) n FROM workflow_runs WHERE workflow_id = ? AND status = 'active'
     AND due_at IS NOT NULL AND due_at <= datetime('now') AND due_at < '9999'`, wf.id
  );
  const pending = wf.graph.nodes
    .filter(n => n.type === 'trigger')
    .reduce((sum, n) => { try { return sum + pendingCount(wf, n); } catch { return sum; } }, 0);

  const { cap, ramping, weeks } = effectiveDailyCap(wf);
  const hours = hoursSince(lastSend);
  const hour = new Date().getHours();
  const imWindow = hour >= wf.window_start && hour < wf.window_end;
  const inboxOk = Boolean((process.env.IMAP_USER || process.env.SMTP_USER) && (process.env.IMAP_PASS || process.env.SMTP_PASS));

  // ── Ist die Abteilung überhaupt im Dienst? ──
  if (!wf.enabled) {
    const check = startklarLinien(wf);
    const blocker = check.filter(l => l.level === 'down').length;
    const offen = check.filter(l => l.level === 'warn').length;
    return {
      level: blocker ? 'down' : offen ? 'warn' : 'off',
      headline: blocker
        ? `Noch nicht startklar: ${blocker} Punkt(e) blockieren den Start.`
        : offen
          ? `Startklar – ${offen} Punkt(e) solltest du vorher noch erledigen.`
          : 'Startklar. Auf „Strategie übernehmen" drücken, dann läuft es.',
      lines: [
        ...check,
        { level: (blocker ? 'down' : 'off') as HealthLevel,
          text: blocker
            ? 'Erst die roten Punkte klären, dann auf „Strategie übernehmen" drücken.'
            : 'Zum Starten oben auf „Strategie übernehmen" drücken.' },
      ],
      sent_today: sentToday, cap_today: cap, last_send_at: lastSend, hours_since_send: hours,
      pending, active_runs: activeRuns, reichweite_tage: null,
    };
  }

  const st: { level: HealthLevel } = { level: 'ok' };
  const worse = (l: HealthLevel) => { if (l === 'down' || (l === 'warn' && st.level === 'ok')) st.level = l; };

  // ── Versand ──
  if (sentToday >= cap) {
    lines.push({ level: 'ok', text: `Tagesziel erreicht: ${sentToday} von ${cap} Mails raus.` });
  } else if (!imWindow) {
    lines.push({ level: 'ok', text: `Außerhalb des Sendefensters (${wf.window_start}–${wf.window_end} Uhr). Heute bisher ${sentToday} Mails.` });
  } else if (dueRuns === 0 && pending === 0) {
    lines.push({ level: 'warn', text: 'Nichts zu tun: keine fälligen Leads und keine neuen in der Warteschlange.' });
    worse('warn');
  } else if (hours != null && hours >= 6) {
    lines.push({ level: 'down', text: `Seit ${hours} Stunden ging keine Mail raus, obwohl ${dueRuns} Leads fällig sind. Bitte prüfen.` });
    worse('down');
  } else {
    lines.push({ level: 'ok', text: `Läuft: ${sentToday} von ${cap} Mails heute, ${dueRuns} Leads stehen an.` });
  }

  if (failedRecently > 0) {
    lines.push({ level: 'down', text: `${failedRecently} Versandfehler in den letzten 24 Stunden – meist SMTP oder Brevo. Im Protokoll steht der Grund.` });
    worse('down');
  }

  // ── Nachschub ──
  const proTag = Math.max(1, cap);
  const offen = pending + activeRuns;
  const reichweite = offen > 0 ? Math.ceil(offen / proTag) : 0;
  if (pending === 0 && activeRuns < proTag) {
    lines.push({ level: 'warn', text: 'Der Lead-Nachschub versiegt: keine neuen Leads in der Warteschlange. Neu scrapen oder importieren.' });
    worse('warn');
  } else {
    lines.push({ level: 'ok', text: `Vorrat: ${activeRuns} Leads in der Strategie, ${pending} warten auf Aufnahme – reicht rund ${reichweite} Tage.` });
  }

  // ── Durchsatz: reicht das Tageslimit für den Vorrat? ──
  if (offen > 0 && reichweite > 21 && !ramping) {
    const ziel = Math.min(150, Math.ceil(offen / 14 / 10) * 10);
    lines.push({
      level: 'warn',
      text: `Bei ${cap} Mails/Tag dauert eine Runde durch alle ${offen} Firmen rund ${reichweite} Tage. `
        + `Mit ${ziel}/Tag wären es etwa 14 – das Limit steht unten unter „Max. Mails / Tag".`,
    });
    worse('warn');
  }

  // ── Antworten ──
  if (!inboxOk) {
    lines.push({ level: 'down', text: 'Das Postfach ist nicht angebunden. Antworten werden nicht erkannt – Interessenten gehen verloren.' });
    worse('down');
  }

  // ── Termin-Link ──
  if (!getSetting('cal_link', '').trim()) {
    lines.push({ level: 'warn', text: 'Kein Cal.com-Link hinterlegt: Bei Interesse geht keine Terminmail raus, es entsteht nur eine Aufgabe.' });
    worse('warn');
  }

  // ── Aufwärmphase ──
  if (ramping) {
    lines.push({ level: 'ok', text: `Aufwärmphase Woche ${weeks + 1}: heute ${cap} Mails erlaubt, Ziel ${wf.daily_cap}. Steigt jede Woche um 30.` });
  }

  // ── Konkurrierende Altsysteme ──
  const runningJobs = one(`SELECT COUNT(*) n FROM send_jobs WHERE status = 'running'`);
  if (runningJobs > 0) {
    lines.push({ level: 'down', text: `${runningJobs} alte Auto-Kampagne(n) laufen parallel. Dieselben Firmen bekommen Post aus zwei Systemen – bitte stoppen.` });
    worse('down');
  }
  const fuOn = (db.prepare(`SELECT enabled FROM followup_config WHERE id = 1`).get() as { enabled: number } | undefined)?.enabled === 1;
  if (fuOn) {
    lines.push({ level: 'warn', text: 'Der alte Follow-up-Worker ist noch aktiv. Die Strategie macht das Nachfassen selbst.' });
    worse('warn');
  }

  // ── Angeschriebene Firmen, die in KEINER Strategie laufen ──
  // Das ist der teuerste blinde Fleck: Arbeit und Zustellkosten sind schon
  // geflossen, aber niemand fasst nach.
  const verwaist = db.prepare(
    `SELECT COALESCE(l.track,'voice_agent') AS track, COUNT(*) AS n
     FROM leads l
     WHERE l.email IS NOT NULL AND l.email != ''
       AND LOWER(TRIM(l.email)) IN (SELECT LOWER(TRIM(to_email)) FROM sent_emails WHERE success = 1)
       AND l.id NOT IN (SELECT lead_id FROM workflow_runs WHERE status = 'active')
       AND COALESCE(l.status,'') != 'duplicate'
     GROUP BY COALESCE(l.track,'voice_agent')`
  ).all() as Array<{ track: string; n: number }>;
  for (const v of verwaist) {
    if (v.n <= 0) continue;
    const eigen = v.track === wf.track;
    lines.push({
      level: 'warn',
      text: eigen
        ? `${v.n} bereits angeschriebene Firmen sind noch in keiner Stage – auf „Bestandsdaten einsortieren" drücken.`
        : `${v.n} angeschriebene Firmen im Bereich „${v.track}" laufen in keiner Strategie. Dafür braucht es eine eigene Strategie mit diesem Track.`,
    });
    worse('warn');
  }

  // ── Vorlagen ──
  const vorlagenWarnung = fehlendeVorlagen(wf);
  if (vorlagenWarnung) { lines.push(vorlagenWarnung); worse('down'); }

  // ── Offene Aufgaben (dein Teil) ──
  const dueTasks = one(`SELECT COUNT(*) n FROM tasks WHERE status = 'open' AND due_at <= datetime('now')`);
  if (dueTasks > 0) {
    lines.push({ level: 'warn', text: `${dueTasks} Aufgaben sind fällig – das sind die heißen Spuren für deine Anrufe.` });
    worse('warn');
  }

  const headline =
    st.level === 'down' ? 'Die E-Mail-Abteilung steht – bitte kurz reinschauen.'
    : st.level === 'warn' ? 'Läuft, aber es gibt etwas zu tun.'
    : 'Alles läuft. Du kannst telefonieren.';

  return {
    level: st.level, headline, lines,
    sent_today: sentToday, cap_today: cap, last_send_at: lastSend, hours_since_send: hours,
    pending, active_runs: activeRuns, reichweite_tage: reichweite || null,
  };
}

/** Kurzfassung für die Übersichtsseite: läuft überhaupt eine Strategie? */
export function anyWorkflowActive(): boolean {
  try { return activeWorkflows().length > 0; } catch { return false; }
}
