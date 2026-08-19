import { getDb } from '../db/schema';
import { Lead } from '../types';
import { v4 as uuid } from 'uuid';
import { sendLeadEmail } from '../email/mailer';
import { getTemplateById, renderTemplate, findTemplateByName } from '../email/template';
import { recordSentEmail, sentTodayCount, GLOBAL_DAILY_CAP } from '../email/auto-sender';
import { updateLeadStatus, recordOutreachEvent } from '../db/leads-repo';
import { isSuppressed, suppressEmail } from './optout';
import { newReply, hasRealClick, hasBounce, lastAutoReplyText, parseReturnDate, parseTs } from './reactions';
import { enroll } from './enroll';
import {
  Workflow, WorkflowNode, WorkflowGraph, CheckPort, PORT_LABELS, PORT_FALLBACK, nodeOutcomes, nodePorts,
  getWorkflow, findNode, nextNodeId, logWorkflow, getSetting, setSetting, initWorkflowSchema, activeWorkflows,
  effectiveDailyCap,
} from './schema';

// ─────────────────────────────────────────────────────────────────────────────
// Workflow-Engine: führt die im Dashboard gebaute Strategie aus.
//
// Ein Lead = ein Run. Der Run steht immer auf genau einem Knoten (= seine Stage)
// und wird pro Tick höchstens einen Schritt weiterbewegt. Drei Dinge laufen bei
// jedem Tick zusätzlich mit:
//   1) Abmelde-Schutz – wer ausdrücklich keine Mails mehr will, wird sofort
//      gesperrt. Das gilt IMMER, auch mitten im Zweig.
//   2) Reaktions-Weiche – Antwort, Bounce oder echter Klick unterbrechen das
//      Warten und leiten den Lauf in den passenden Zweig um.
//   3) Manuelle Stages – auf 'stage'/'call' wartet der Lauf auf einen Menschen.
//      Automatik und Handarbeit greifen so ineinander statt gegeneinander.
// ─────────────────────────────────────────────────────────────────────────────

const TICK_MS = 15_000;
const MAX_RUNS_PER_TICK = 40;
const MAX_STEPS_PER_RUN = 400;

const LAST_SEND_KEY = 'wf_last_send_at';
/** Haltepunkt: Der Lauf wartet auf eine menschliche Entscheidung, nicht auf die Uhr. */
const HOLD_UNTIL = '9999-12-31T00:00:00.000Z';

export interface RunRow {
  id: string;
  workflow_id: string;
  lead_id: string;
  trigger_id: string | null;
  node_id: string | null;
  status: string;
  due_at: string | null;
  steps: number;
  resume_node: string | null;
  watch_off: number;
  snooze_until: string | null;
  last_reaction_uid: number | null;
  started_at: string;
  updated_at: string;
  finished_at: string | null;
}

const nowIso = () => new Date().toISOString();

function setRun(id: string, fields: Record<string, unknown>): void {
  const sets = Object.keys(fields).map(k => `${k} = @${k}`).join(', ');
  getDb().prepare(`UPDATE workflow_runs SET ${sets}, updated_at = @__now WHERE id = @__id`)
    .run({ ...fields, __id: id, __now: nowIso() });
}

function finishRun(run: RunRow, status: 'done' | 'stopped' | 'error', reason: string, lead?: Lead): void {
  setRun(run.id, { status, finished_at: nowIso(), node_id: run.node_id });
  logWorkflow({
    run_id: run.id, lead_id: run.lead_id, lead_name: lead?.name ?? null,
    node_id: run.node_id, action: status === 'done' ? 'Lauf beendet' : 'Lauf gestoppt',
    detail: reason, level: status === 'error' ? 'warn' : 'info',
  });
}

function getLead(id: string): Lead | undefined {
  return getDb().prepare('SELECT * FROM leads WHERE id = ?').get(id) as Lead | undefined;
}

export function activeRunForLead(leadId: string): RunRow | undefined {
  return getDb().prepare(
    `SELECT * FROM workflow_runs WHERE lead_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1`
  ).get(leadId) as RunRow | undefined;
}

// ── Versand-Schranken ───────────────────────────────────────────────────────

function sentTodayByWorkflow(): number {
  return (getDb().prepare(
    `SELECT COUNT(*) n FROM sent_emails
     WHERE success = 1 AND campaign LIKE 'wf-%'
       AND sent_at >= datetime('now','start of day','localtime')`
  ).get() as { n: number }).n;
}

function checkSendGate(wf: Workflow, urgent: boolean): { ok: boolean; reason?: string } {
  if (sentTodayCount() >= GLOBAL_DAILY_CAP) return { ok: false, reason: `Globales Tageslimit ${GLOBAL_DAILY_CAP} erreicht` };
  const { cap, ramping } = effectiveDailyCap(wf);
  if (sentTodayByWorkflow() >= cap) {
    return { ok: false, reason: `Tageslimit ${cap} erreicht${ramping ? ` (Aufwärmphase, Ziel ${wf.daily_cap})` : ''}` };
  }
  if (urgent) return { ok: true };

  const hour = new Date().getHours();
  if (hour < wf.window_start || hour >= wf.window_end) {
    return { ok: false, reason: `Außerhalb des Sendefensters ${wf.window_start}–${wf.window_end} Uhr` };
  }
  const last = parseTs(getSetting(LAST_SEND_KEY, ''));
  if (last && Date.now() - last < wf.min_gap_s * 1000) {
    return { ok: false, reason: 'Mindestabstand zwischen zwei Mails noch nicht erreicht' };
  }
  return { ok: true };
}

// ── Knoten ausführen ────────────────────────────────────────────────────────

function advance(run: RunRow, wf: Workflow, from: string, port = 'out', delayMs = 0): void {
  const target = nextNodeId(wf.graph, from, port);
  if (!target) {
    finishRun(run, 'done', `Kein Ausgang "${port}" verbunden`);
    return;
  }
  setRun(run.id, {
    node_id: target,
    due_at: new Date(Date.now() + delayMs).toISOString(),
    steps: run.steps + 1,
  });
}

function createTask(lead: Lead, node: WorkflowNode, detail?: string, titleOverride?: string): void {
  const cfg = node.config as { kind?: string; title?: string; due_hours?: number };
  const dueHours = Number(cfg.due_hours);
  const title = (titleOverride || cfg.title || node.title || 'Aufgabe').slice(0, 200);
  const db = getDb();
  // Nicht doppelt anlegen, wenn für denselben Lead dieselbe Aufgabe schon offen ist.
  if (db.prepare(`SELECT 1 x FROM tasks WHERE lead_id = ? AND title = ? AND status = 'open' LIMIT 1`).get(lead.id, title)) return;
  db.prepare(
    `INSERT INTO tasks (id, lead_id, kind, title, note, due_at, status, source)
     VALUES (@id, @lead_id, @kind, @title, @note, @due_at, 'open', 'workflow')`
  ).run({
    id: uuid(),
    lead_id: lead.id,
    kind: cfg.kind || (node.type === 'call' ? 'call' : 'todo'),
    title,
    note: detail ?? null,
    due_at: new Date(Date.now() + (Number.isFinite(dueHours) ? dueHours : 24) * 3_600_000).toISOString(),
  });
}

function applyNodeStatus(node: WorkflowNode, lead: Lead): void {
  const status = (node.config as { status?: string }).status;
  if (!status || lead.status === status) return;
  updateLeadStatus(lead.id, status as Lead['status'], { notiz: `Stage "${node.title}" im Workflow erreicht` });
}

/** Zeitpunkt, bis zu dem eine Wiedervorlage laufen soll. */
function snoozeUntil(node: WorkflowNode, lead: Lead): Date {
  const manual = parseTs(lead.wiedervorlage_at);
  if (manual && manual > Date.now()) return new Date(manual);
  const days = Number((node.config as { days?: number }).days);
  return new Date(Date.now() + (Number.isFinite(days) ? days : 2) * 86_400_000);
}

async function executeNode(wf: Workflow, run: RunRow, node: WorkflowNode, lead: Lead): Promise<boolean> {
  switch (node.type) {
    case 'trigger': {
      // Die Wurzel verteilt nach Kontaktweg: mit E-Mail, nur Telefon, gar nichts.
      // Der Ausgang "Angeschrieben" gehoert dem Bestand und wird beim Einsortieren gesetzt.
      if ((node.config as { route?: string }).route === 'kategorie') {
        const port = lead.email ? 'neu' : (lead.telefon_direkt || lead.telefon) ? 'angerufen' : 'kein_kontakt';
        advance(run, wf, node.id, port);
        return false;
      }
      advance(run, wf, node.id);
      return false;
    }

    case 'wait': {
      const days = Number((node.config as { days?: number }).days);
      const d = Number.isFinite(days) ? days : 1;
      advance(run, wf, node.id, 'out', d * 86_400_000);
      logWorkflow({
        run_id: run.id, lead_id: lead.id, lead_name: lead.name, node_id: node.id, node_type: 'wait',
        action: 'Wartet', detail: `${d} Tage bis zum nächsten Schritt`,
      });
      return false;
    }

    case 'email':
      return sendNodeEmail(wf, run, node, lead);

    // Manuelle Stage: der Lauf bleibt stehen, bis ein Mensch ein Ergebnis wählt.
    case 'stage':
    case 'call': {
      applyNodeStatus(node, lead);
      if (node.type === 'call') {
        createTask(lead, node, `Nummer: ${lead.telefon_direkt || lead.telefon || 'keine hinterlegt'}`, `Anrufen: ${lead.name}`);
      }
      setRun(run.id, { due_at: HOLD_UNTIL, steps: run.steps + 1, snooze_until: null });
      logWorkflow({
        run_id: run.id, lead_id: lead.id, lead_name: lead.name, node_id: node.id, node_type: node.type,
        action: `Stage erreicht: ${node.title}`,
        detail: nodeOutcomes(node).length ? 'Wartet auf deine Entscheidung' : 'Endstation dieser Stage',
        level: node.type === 'call' ? 'hot' : 'info',
      });
      return false;
    }

    case 'snooze': {
      if (!run.snooze_until) {
        const until = snoozeUntil(node, lead);
        setRun(run.id, { snooze_until: until.toISOString(), due_at: until.toISOString(), steps: run.steps + 1 });
        logWorkflow({
          run_id: run.id, lead_id: lead.id, lead_name: lead.name, node_id: node.id, node_type: 'snooze',
          action: 'Wiedervorlage gesetzt', level: 'warn',
          detail: `Weiter am ${until.toLocaleDateString('de-DE')}${lead.wiedervorlage_grund ? ' – ' + lead.wiedervorlage_grund : ''}`,
        });
        return false;
      }
      // Fällig: Wiedervorlage aufheben und weiter (oder zurück zum Ausgangspunkt).
      const back = nextNodeId(wf.graph, node.id) ?? run.resume_node;
      getDb().prepare(`UPDATE leads SET wiedervorlage_at = NULL, wiedervorlage_grund = NULL WHERE id = ?`).run(lead.id);
      if (!back) { finishRun(run, 'done', 'Wiedervorlage ohne Rückkehrpunkt', lead); return false; }
      setRun(run.id, { node_id: back, due_at: nowIso(), snooze_until: null, resume_node: null, watch_off: 0, steps: run.steps + 1 });
      logWorkflow({
        run_id: run.id, lead_id: lead.id, lead_name: lead.name, node_id: node.id, node_type: 'snooze',
        action: 'Wiedervorlage fällig', detail: `Weiter mit "${findNode(wf.graph, back)?.title ?? back}"`, level: 'hot',
      });
      return false;
    }

    case 'task': {
      createTask(lead, node);
      logWorkflow({
        run_id: run.id, lead_id: lead.id, lead_name: lead.name, node_id: node.id, node_type: 'task',
        action: 'Aufgabe angelegt', detail: String((node.config as { title?: string }).title || node.title), level: 'hot',
      });
      recordOutreachEvent({
        lead_id: lead.id, event_type: 'note', channel: 'workflow', user: 'workflow',
        note: `Aufgabe aus Workflow: ${(node.config as { title?: string }).title || node.title}`,
      });
      advance(run, wf, node.id);
      return false;
    }

    case 'status': {
      applyNodeStatus(node, lead);
      logWorkflow({
        run_id: run.id, lead_id: lead.id, lead_name: lead.name, node_id: node.id, node_type: 'status',
        action: 'Status gesetzt', detail: String((node.config as { status?: string }).status || ''),
      });
      advance(run, wf, node.id);
      return false;
    }

    case 'suppress': {
      if (lead.email) suppressEmail(lead.email, `Workflow-Sperre über Knoten "${node.title}"`, 'workflow');
      updateLeadStatus(lead.id, 'no_interest', { notiz: 'Abmeldung/kein Interesse – dauerhaft gesperrt' });
      logWorkflow({
        run_id: run.id, lead_id: lead.id, lead_name: lead.name, node_id: node.id, node_type: 'suppress',
        action: 'Dauerhaft gesperrt', detail: `${lead.email || 'ohne E-Mail'} bekommt nie wieder eine E-Mail`, level: 'warn',
      });
      // Weiterleiten, damit der Lead sichtbar in einer Stage landet (z. B. "Kein Interesse").
      if (nextNodeId(wf.graph, node.id)) advance(run, wf, node.id);
      else finishRun(run, 'stopped', 'Adresse gesperrt', lead);
      return false;
    }

    case 'pause': {
      const cfg = node.config as { fallback_days?: number };
      const parsed = parseReturnDate(lastAutoReplyText(lead.id));
      const fallbackDays = Number.isFinite(Number(cfg.fallback_days)) ? Number(cfg.fallback_days) : 7;
      const until = parsed ?? new Date(Date.now() + fallbackDays * 86_400_000);
      const backTo = nextNodeId(wf.graph, node.id) ?? run.resume_node;

      if (!backTo) { finishRun(run, 'done', 'Pause ohne Rückkehrpunkt', lead); return false; }
      setRun(run.id, {
        node_id: backTo, due_at: until.toISOString(), watch_off: 0,
        resume_node: null, steps: run.steps + 1,
      });
      logWorkflow({
        run_id: run.id, lead_id: lead.id, lead_name: lead.name, node_id: node.id, node_type: 'pause',
        action: 'Sequenz pausiert', level: 'warn',
        detail: `Abwesenheit erkannt – weiter am ${until.toLocaleDateString('de-DE')}${parsed ? ' (aus der Notiz gelesen)' : ' (Standardwartezeit)'}`,
      });
      return false;
    }

    case 'check': {
      // Die Weiche steht IM Pfad: Sobald die Wartezeit vorbei ist, entscheidet sie.
      // Gab es eine Reaktion, hat die laufende Prüfung den Lauf schon vorher umgeleitet –
      // hier bleibt der Normalfall: keine Antwort, also nächste Stufe.
      const target = wiredPort(wf.graph, node, 'no_reply');
      if (!target) { finishRun(run, 'done', 'Weiche ohne Ausgang "Keine Antwort"', lead); return false; }
      advance(run, wf, node.id, 'no_reply');
      logWorkflow({
        run_id: run.id, lead_id: lead.id, lead_name: lead.name, node_id: node.id, node_type: 'check',
        action: 'Keine Antwort', detail: `weiter mit "${findNode(wf.graph, target)?.title ?? target}"`,
      });
      return false;
    }

    case 'stop':
    default:
      finishRun(run, 'done', `Endknoten "${node.title}" erreicht`, lead);
      return false;
  }
}

/**
 * Welche Vorlage nimmt dieser Knoten?
 *
 * Für den Erstkontakt gibt es zwei gleichwertige Varianten. Statt den Baum zu
 * verdoppeln, hält EIN Knoten beide und wechselt zufällig – so bekommt nicht
 * jeder Betrieb denselben Betreff, was zusätzlich das Spam-Risiko senkt.
 */
function pickTemplateId(node: WorkflowNode): string {
  const cfg = node.config as { template_id?: string; template_ids?: unknown; template_match?: unknown };

  // 1. Über den Namen der Vorlage – so bleibt die Strategie an DEINEN Vorlagen
  //    hängen, auch wenn sie neu angelegt oder umbenannt werden.
  const namen = Array.isArray(cfg.template_match)
    ? cfg.template_match.filter((t): t is string => typeof t === 'string' && t.trim() !== '')
    : typeof cfg.template_match === 'string' && cfg.template_match.trim() ? [cfg.template_match] : [];
  if (namen.length) {
    const treffer = namen.map(n => findTemplateByName(n)).filter(Boolean);
    if (treffer.length) return treffer[Math.floor(Math.random() * treffer.length)]!.id;
  }

  // 2. Feste IDs (mehrere = Zufallswechsel, z. B. zwei Erstkontakt-Varianten)
  const liste = Array.isArray(cfg.template_ids)
    ? cfg.template_ids.filter((t): t is string => typeof t === 'string' && t.trim() !== '')
    : [];
  if (liste.length) return liste[Math.floor(Math.random() * liste.length)];

  return String(cfg.template_id || 'default');
}

async function sendNodeEmail(wf: Workflow, run: RunRow, node: WorkflowNode, lead: Lead): Promise<boolean> {
  const cfg = node.config as { template_id?: string; urgent?: boolean };
  if (!lead.email) {
    logWorkflow({ run_id: run.id, lead_id: lead.id, lead_name: lead.name, node_id: node.id, node_type: 'email', action: 'Übersprungen', detail: 'Keine E-Mail-Adresse', level: 'warn' });
    advance(run, wf, node.id);
    return false;
  }
  if (isSuppressed(lead.email)) {
    finishRun(run, 'stopped', 'Adresse steht auf der Sperrliste', lead);
    return false;
  }

  const tpl = getTemplateById(pickTemplateId(node));
  if (!tpl) {
    logWorkflow({ run_id: run.id, lead_id: lead.id, lead_name: lead.name, node_id: node.id, node_type: 'email', action: 'Vorlage fehlt', detail: `Vorlage "${pickTemplateId(node)}" existiert nicht – Knoten übersprungen`, level: 'warn' });
    advance(run, wf, node.id);
    return false;
  }

  if (!checkSendGate(wf, Boolean(cfg.urgent)).ok) {
    setRun(run.id, { due_at: new Date(Date.now() + 5 * 60_000).toISOString() });
    return false;
  }

  const rendered = renderTemplate(tpl, {
    name: lead.name, branche: lead.branche, stadt: lead.stadt, ansprechpartner: lead.geschaeftsfuehrer,
  });
  const terminLink = getSetting('cal_link', '').trim();
  const needsLink = /\{termin_link\}/.test(rendered.body) || /\{termin_link\}/.test(rendered.subject);

  // Terminmail ohne hinterlegten Buchungslink darf NICHT halbfertig rausgehen.
  if (needsLink && !terminLink) {
    createTask(lead, node, `Kein Cal-Link hinterlegt. Fertiger Text:\n\n${rendered.subject}\n\n${rendered.body}`,
      `Terminmail von Hand senden an ${lead.name}`);
    logWorkflow({
      run_id: run.id, lead_id: lead.id, lead_name: lead.name, node_id: node.id, node_type: 'email',
      action: 'Terminmail NICHT gesendet', level: 'warn',
      detail: 'Kein Cal.com-Link hinterlegt – stattdessen Aufgabe mit fertigem Text angelegt.',
    });
    advance(run, wf, node.id);
    return false;
  }

  const subject = rendered.subject.replace(/\{termin_link\}/g, terminLink);
  const body = rendered.body.replace(/\{termin_link\}/g, terminLink);
  const trackingId = uuid();

  let result;
  try {
    result = await sendLeadEmail({ leadId: lead.id, to: lead.email, toName: lead.name, subject, body, trackingId });
  } catch (err) {
    result = { success: false, error: err instanceof Error ? err.message : String(err) };
  }

  recordSentEmail({
    id: trackingId, lead_id: lead.id, campaign: `wf-${node.id}`, to_email: lead.email, to_name: lead.name,
    subject, body, template_id: tpl.id,
    success: result.success, error: result.error, message_id: (result as { messageId?: string }).messageId,
  });

  if (result.success) {
    setSetting(LAST_SEND_KEY, nowIso());
    if (!['contacted', 'replied', 'demo_booked', 'proposal_sent', 'won'].includes(lead.status)) {
      updateLeadStatus(lead.id, 'contacted', { notiz: `Workflow-Mail gesendet (${node.title})` });
    }
    recordOutreachEvent({
      lead_id: lead.id, event_type: 'email_sent', channel: 'email', status: 'contacted', user: 'workflow',
      note: `Workflow "${node.title}" an ${lead.email} | Betreff: "${subject}"`,
    });
    logWorkflow({
      run_id: run.id, lead_id: lead.id, lead_name: lead.name, node_id: node.id, node_type: 'email',
      action: 'E-Mail gesendet', detail: `${node.title} → ${lead.email} · Betreff: "${subject}"`, level: 'send',
    });
    advance(run, wf, node.id);
    return true;
  }

  logWorkflow({
    run_id: run.id, lead_id: lead.id, lead_name: lead.name, node_id: node.id, node_type: 'email',
    action: 'Versand fehlgeschlagen', detail: (result.error || '').slice(0, 200), level: 'warn',
  });
  setRun(run.id, { due_at: new Date(Date.now() + 15 * 60_000).toISOString() });
  return false;
}

// ── Ein Lauf, ein Schritt ───────────────────────────────────────────────────

async function stepRun(wf: Workflow, run: RunRow, sendBudget: { left: number }): Promise<void> {
  const lead = getLead(run.lead_id);
  if (!lead) { finishRun(run, 'stopped', 'Lead existiert nicht mehr'); return; }
  if (run.steps > MAX_STEPS_PER_RUN) { finishRun(run, 'error', 'Schrittgrenze erreicht – Graph prüfen', lead); return; }

  const node = findNode(wf.graph, run.node_id);

  // 1) Von Hand gesetzter Status (Anrufliste, CRM, Pipeline) zieht den Lauf nach.
  //    Muss VOR der Sperrprüfung laufen: Ein auf "kein Interesse" gesetzter Lead
  //    soll sichtbar in seiner Stage stehen, nicht wortlos aus dem Baum fallen.
  if (syncStatusToStage(wf, run, lead)) return;

  // 2) Abmelde-Schutz. Gesperrte Adressen dürfen die Sende-Sequenz nicht weiterlaufen.
  //    Auf einem Sperr- oder Stage-Knoten bleibt der Lauf dagegen bestehen: dort geht
  //    nichts mehr raus, und der Lead ist im Board sichtbar (z. B. "Kein Interesse").
  const SENDING_NODES = ['email', 'wait', 'trigger', 'check', 'snooze', 'pause'];
  if (lead.email && isSuppressed(lead.email) && (!node || SENDING_NODES.includes(node.type))) {
    finishRun(run, 'stopped', 'Adresse gesperrt – kein weiterer Kontakt', lead);
    return;
  }

  // Endstationen bleiben Endstationen: Wer auf einer Stage ohne Ausgang steht
  // (z. B. "Kein Interesse", "Kunde"), wird von einer alten Antwort nicht erneut
  // durch den Baum geschickt.
  const terminal = Boolean(node && (node.type === 'stage' || node.type === 'call')
    && nodeOutcomes(node).length === 0
    && !wf.graph.edges.some(e => e.from === node.id));

  // 3) Neue Antwort? Abmeldung sofort umsetzen, sonst Weiche stellen.
  const reaction = newReply(run);
  if (reaction) {
    setRun(run.id, { last_reaction_uid: reaction.uid });
    if (reaction.optOutPhrase) {
      if (lead.email) suppressEmail(lead.email, `Ausdrücklicher Widerspruch in der Antwort ("${reaction.optOutPhrase}")`, 'reply');
      updateLeadStatus(lead.id, reaction.hardOptOut ? 'do_not_contact' : 'no_interest', {
        notiz: `Abmeldung erkannt ("${reaction.optOutPhrase}") – dauerhaft gesperrt`,
      });
      logWorkflow({
        run_id: run.id, lead_id: lead.id, lead_name: lead.name, node_id: run.node_id, node_type: 'check',
        action: 'Abmeldung – dauerhaft gesperrt', level: 'warn',
        detail: `Formulierung: "${reaction.optOutPhrase}". Diese Adresse wird von keinem Versandweg mehr angeschrieben.`,
      });
      if (!routeReaction(wf, run, lead, 'not_interested', 'Abmeldung')) finishRun(run, 'stopped', 'Abmeldung', lead);
      return;
    }
    if (!run.watch_off && !terminal && routeReaction(wf, run, lead, reaction.port, reaction.detail)) return;
  }

  // 4) Bounce – die Adresse ist nachweislich ungültig.
  if (!run.watch_off && !terminal && hasBounce(run.lead_id) && routeReaction(wf, run, lead, 'bounce', 'Zustellung fehlgeschlagen')) return;

  // 5) Echter Klick ohne Antwort.
  if (!run.watch_off && !terminal && hasRealClick(run.lead_id, parseTs(run.started_at))
      && routeReaction(wf, run, lead, 'clicked', 'Hat einen Link in der Mail geklickt')) return;

  // 6) Fällig? Dann genau einen Knoten ausführen.
  if (parseTs(run.due_at) > Date.now()) return;
  if (!node) { finishRun(run, 'error', `Knoten "${run.node_id}" fehlt im Graphen`, lead); return; }
  if (node.type === 'email' && sendBudget.left <= 0) return;

  const didSend = await executeNode(wf, run, node, lead);
  if (didSend) sendBudget.left--;
}

/** Gibt es fuer diesen Ausgang eine Verbindung? Liefert das Ziel oder null. */
function wiredPort(graph: WorkflowGraph, node: WorkflowNode, port: string): string | null {
  return nextNodeId(graph, node.id, port);
}

/**
 * Die naechste Weiche, die auf dem Weg des Leads liegt.
 *
 * Der Baum wiederholt die Weiche nach jeder Stufe, statt alles an eine zentrale
 * Weiche zu haengen. Deshalb zaehlt nicht "die eine" Weiche, sondern die naechste
 * vorwaerts erreichbare – so landet eine Antwort im richtigen Abschnitt des Baums.
 */
function findCheckFor(graph: WorkflowGraph, fromId: string | null): WorkflowNode | null {
  if (fromId) {
    const start = findNode(graph, fromId);
    if (start?.type === 'check') return start;
    const seen = new Set<string>([fromId]);
    let frontier = [fromId];
    for (let depth = 0; depth < 5 && frontier.length; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const e of graph.edges.filter(x => x.from === id)) {
          if (seen.has(e.to)) continue;
          seen.add(e.to);
          const n = findNode(graph, e.to);
          if (n?.type === 'check') return n;
          next.push(e.to);
        }
      }
      frontier = next;
    }
  }
  return graph.nodes.find(n => n.type === 'check') ?? null;
}

/**
 * Zieht den Lauf nach, wenn der Status von Hand geändert wurde.
 *
 * Der Nutzer arbeitet nicht nur im Baum: In der Anrufliste, im CRM und in der
 * Pipeline setzt er Ergebnisse („Termin gebucht", „Kein Interesse", „Gewonnen").
 * Ohne diesen Abgleich liefe die Mail-Sequenz stur weiter, während er längst
 * telefoniert hat – der Betrieb bekäme nach dem gebuchten Termin noch ein
 * „Letzter Versuch". Die Prüfung läuft bei JEDEM Tick und wirkt deshalb
 * unabhängig davon, an welcher Stelle der Status geändert wurde.
 *
 * Bewusst NICHT synchronisiert werden Zwischenstände wie 'contacted' oder
 * 'manual_review' („nicht erreicht") – die sollen den Lauf nicht verschieben.
 */
function syncStatusToStage(wf: Workflow, run: RunRow, lead: Lead): boolean {
  const ziele: string[] = [];
  for (const n of wf.graph.nodes) {
    if ((n.config as { status?: string }).status === lead.status) ziele.push(n.id);
  }
  if (!ziele.length) return false;
  if (run.node_id && ziele.includes(run.node_id)) return false;   // steht schon richtig

  // Innerhalb desselben Astes bleiben, wenn es dort eine passende Stage gibt.
  const ast = String(run.node_id || '').split('_')[0] + '_';
  const target = ziele.find(z => z.startsWith(ast)) ?? ziele[0];

  setRun(run.id, { node_id: target, due_at: nowIso(), snooze_until: null, steps: run.steps + 1 });
  logWorkflow({
    run_id: run.id, lead_id: lead.id, lead_name: lead.name, node_id: target, node_type: 'stage',
    action: 'Status von Hand geändert', level: 'hot',
    detail: `Status "${lead.status}" → Lead steht jetzt auf "${findNode(wf.graph, target)?.title ?? target}"`,
  });
  return true;
}

/** Leitet den Lauf in den passenden Zweig der Reaktions-Weiche. true = umgeleitet. */
function routeReaction(wf: Workflow, run: RunRow, lead: Lead, port: CheckPort, detail: string): boolean {
  const checkNode = findCheckFor(wf.graph, run.node_id);
  if (!checkNode) return false;

  // Eigener Ausgang, sonst der vorgesehene Ersatz (z. B. Bounce → Sonderfall).
  const candidates: CheckPort[] = [port, ...((PORT_FALLBACK[port] || []) as CheckPort[])];
  let used: CheckPort | null = null, target: string | null = null;
  for (const p of candidates) {
    const t = wiredPort(wf.graph, checkNode, p);
    if (t) { used = p; target = t; break; }
  }

  // Manche Ausgänge hängen bewusst nur an der ERSTEN Weiche eines Astes, damit das
  // Bild ruhig bleibt (z. B. die Abwesenheitsnotiz). Trotzdem kann eine
  // Urlaubsmeldung auch auf Follow-up 2 kommen – jemand fährt eben später weg.
  // Dann greifen wir auf die passende Weiche desselben Astes zurück, statt die
  // Meldung zu verschlucken und weiter in ein leeres Büro zu schreiben.
  if (!target) {
    const ast = checkNode.id.split('_')[0] + '_';
    for (const n of wf.graph.nodes) {
      if (n.type !== 'check' || !n.id.startsWith(ast)) continue;
      for (const p of candidates) {
        const t = wiredPort(wf.graph, n, p);
        if (t) { used = p; target = t; break; }
      }
      if (target) break;
    }
  }
  if (!target || !used || run.node_id === target) return false;
  port = used;

  // Urlaub und "später" kehren an die aktuelle Stelle zurück, alles andere ist ein Spurwechsel.
  const resuming = port === 'auto_reply' || port === 'later';
  setRun(run.id, {
    node_id: target,
    due_at: nowIso(),
    snooze_until: null,
    resume_node: resuming ? run.node_id : null,
    watch_off: resuming ? 0 : 1,
    steps: run.steps + 1,
  });
  logWorkflow({
    run_id: run.id, lead_id: lead.id, lead_name: lead.name, node_id: checkNode.id, node_type: 'check',
    action: `Weiche: ${PORT_LABELS[port]}`,
    detail: `${detail} → weiter mit "${findNode(wf.graph, target)?.title ?? target}"`,
    level: port === 'interested' || port === 'question' || port === 'clicked' ? 'hot' : 'info',
  });
  return true;
}

// ── Manuelle Steuerung aus dem Dashboard ────────────────────────────────────

export interface AdvanceResult { ok: boolean; error?: string; node_id?: string; node_title?: string }

/** Ergebnis einer Stage von Hand wählen – der Lauf springt auf den zugehörigen Ausgang. */
export function advanceLeadManually(leadId: string, port: string, note?: string): AdvanceResult {
  const run = activeRunForLead(leadId);
  if (!run) return { ok: false, error: 'Dieser Lead läuft gerade in keiner Strategie' };
  let wf: Workflow;
  try { wf = getWorkflow(run.workflow_id); } catch { return { ok: false, error: 'Strategie nicht gefunden' }; }

  const node = findNode(wf.graph, run.node_id);
  if (!node) return { ok: false, error: 'Aktueller Knoten fehlt im Graphen' };
  const target = nextNodeId(wf.graph, node.id, port);
  if (!target) return { ok: false, error: `Für "${port}" ist kein nächster Schritt verbunden` };

  const lead = getLead(leadId);
  setRun(run.id, { node_id: target, due_at: nowIso(), steps: run.steps + 1, snooze_until: null, watch_off: 0 });
  const outcome = nodeOutcomes(node).find(o => o.key === port);
  logWorkflow({
    run_id: run.id, lead_id: leadId, lead_name: lead?.name ?? null, node_id: node.id, node_type: node.type,
    action: `Von Hand: ${outcome?.label || port}`,
    detail: `${node.title} → "${findNode(wf.graph, target)?.title ?? target}"${note ? ' · ' + note : ''}`,
    level: 'hot',
  });
  if (note) recordOutreachEvent({ lead_id: leadId, event_type: 'note', channel: 'workflow', user: 'mensch', note });
  return { ok: true, node_id: target, node_title: findNode(wf.graph, target)?.title };
}

/** Wiedervorlage setzen: der Lauf pausiert bis zum Datum. */
export function snoozeLead(leadId: string, untilIso: string, grund?: string): AdvanceResult {
  const run = activeRunForLead(leadId);
  if (!run) return { ok: false, error: 'Dieser Lead läuft gerade in keiner Strategie' };
  const until = new Date(untilIso);
  if (Number.isNaN(until.getTime())) return { ok: false, error: 'Ungültiges Datum' };
  getDb().prepare(`UPDATE leads SET wiedervorlage_at = ?, wiedervorlage_grund = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(until.toISOString(), grund ?? null, leadId);
  setRun(run.id, { due_at: until.toISOString(), snooze_until: until.toISOString() });
  const lead = getLead(leadId);
  logWorkflow({
    run_id: run.id, lead_id: leadId, lead_name: lead?.name ?? null, node_id: run.node_id,
    action: 'Wiedervorlage von Hand', level: 'warn',
    detail: `Weiter am ${until.toLocaleDateString('de-DE')}${grund ? ' – ' + grund : ''}`,
  });
  return { ok: true };
}

/**
 * Lead auf eine BELIEBIGE Stage setzen – für Fälle, die keine Kante vorsieht,
 * etwa "gehört nicht in diese Kampagne" (Parkplatz "Sonstige").
 */
export function moveLeadToNode(leadId: string, nodeId: string, note?: string): AdvanceResult {
  const run = activeRunForLead(leadId);
  if (!run) return { ok: false, error: 'Dieser Lead läuft gerade in keiner Strategie' };
  let wf: Workflow;
  try { wf = getWorkflow(run.workflow_id); } catch { return { ok: false, error: 'Strategie nicht gefunden' }; }
  const target = findNode(wf.graph, nodeId);
  if (!target) return { ok: false, error: 'Diese Stage gibt es nicht' };

  const lead = getLead(leadId);
  setRun(run.id, { node_id: target.id, due_at: nowIso(), steps: run.steps + 1, snooze_until: null, watch_off: 0 });
  logWorkflow({
    run_id: run.id, lead_id: leadId, lead_name: lead?.name ?? null, node_id: target.id, node_type: target.type,
    action: 'Von Hand verschoben', detail: `→ "${target.title}"${note ? ' · ' + note : ''}`, level: 'warn',
  });
  if (note) recordOutreachEvent({ lead_id: leadId, event_type: 'note', channel: 'workflow', user: 'mensch', note });
  return { ok: true, node_id: target.id, node_title: target.title };
}

/** Diesen Lead sofort weiterlaufen lassen (z. B. Follow-up jetzt senden). */
export function runLeadNow(leadId: string): AdvanceResult {
  const run = activeRunForLead(leadId);
  if (!run) return { ok: false, error: 'Dieser Lead läuft gerade in keiner Strategie' };
  setRun(run.id, { due_at: nowIso(), snooze_until: null });
  return { ok: true };
}

// ── Tick ────────────────────────────────────────────────────────────────────

export async function runWorkflowTick(): Promise<{ enrolled: number; stepped: number }> {
  initWorkflowSchema();
  const workflows = activeWorkflows();
  if (!workflows.length) return { enrolled: 0, stepped: 0 };

  // Ein Sendebudget für ALLE aktiven Strategien zusammen: höchstens eine Mail pro
  // Tick, damit mehrere Strategien den Versandtakt nicht gemeinsam hochtreiben.
  const sendBudget = { left: 1 };
  let enrolled = 0, stepped = 0;

  for (const wf of workflows) {
    enrolled += enroll(wf);
    const runs = getDb().prepare(
      `SELECT * FROM workflow_runs WHERE workflow_id = ? AND status = 'active'
       ORDER BY COALESCE(due_at, started_at) ASC LIMIT ?`
    ).all(wf.id, MAX_RUNS_PER_TICK) as RunRow[];

    for (const run of runs) {
      try {
        await stepRun(wf, run, sendBudget);
        stepped++;
      } catch (err) {
        logWorkflow({
          run_id: run.id, lead_id: run.lead_id, node_id: run.node_id, action: 'Fehler im Lauf',
          detail: err instanceof Error ? err.message : String(err), level: 'warn',
        });
      }
    }
  }
  return { enrolled, stepped };
}

let timer: ReturnType<typeof setInterval> | null = null;
let busy = false;

export function startWorkflowEngine(): void {
  if (timer) return;
  initWorkflowSchema();
  timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await runWorkflowTick(); }
    catch (err) { console.error('[workflow] Tick-Fehler:', err instanceof Error ? err.message : err); }
    finally { busy = false; }
  }, TICK_MS);
  console.log('[workflow] Engine gestartet (Tick ' + TICK_MS / 1000 + 's)');
}
