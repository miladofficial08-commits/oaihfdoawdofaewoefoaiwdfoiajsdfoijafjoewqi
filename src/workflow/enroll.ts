import { getDb } from '../db/schema';
import { Lead } from '../types';
import { v4 as uuid } from 'uuid';
import { isSuppressed } from './optout';
import { Workflow, WorkflowNode, findNode, nextNodeId, logWorkflow } from './schema';

// Wer kommt wann in die Strategie? Getrennt von der Ausführung, weil hier eine
// eigene Frage beantwortet wird: welche Leads sind überhaupt Kandidaten – und
// wie viele warten gerade darauf, aufgenommen zu werden.

const nowIso = () => new Date().toISOString();
const MAX_ENROLL_PER_TICK = 5;

// ── Eintritt in den Workflow ────────────────────────────────────────────────

const ENROLL_STATUS_OK = `status IN ('new','checked','draft_ready','approved','manual_review')`;

// Nie zweimal dieselbe Adresse: bereits gesendete oder eingeplante Mails sperren den Eintritt.
const NOT_YET_CONTACTED = `LOWER(TRIM(COALESCE(email,''))) NOT IN (
    SELECT LOWER(TRIM(to_email)) FROM sent_emails      WHERE success = 1                          AND to_email IS NOT NULL AND to_email != ''
    UNION
    SELECT LOWER(TRIM(to_email)) FROM scheduled_emails WHERE status IN ('scheduled','processing') AND to_email IS NOT NULL AND to_email != ''
    UNION
    SELECT email_normalized FROM email_suppression     WHERE email_normalized IS NOT NULL AND email_normalized != ''
  )`;

/**
 * Baut die Auswahlbedingung eines Start-Knotens. Wird von der Aufnahme UND von der
 * Wartend-Anzeige im Dashboard genutzt – damit zeigt die Zahl im Knoten exakt das,
 * was der Workflow als Nächstes aufnehmen wird (z. B. frisch importierte Leads).
 */
function candidateQuery(wf: Workflow, trigger: WorkflowNode): { where: string; params: Record<string, unknown> } {
  const cfg = trigger.config as { source?: string; status?: string; prioritaet?: string; branche?: string; requires_email?: string };
  const params: Record<string, unknown> = { track: wf.track };
  let where: string;

  if (cfg.source === 'status') {
    params.status = cfg.status || 'demo_booked';
    where = `status = @status`;
  } else {
    where = `${ENROLL_STATUS_OK} AND ${NOT_YET_CONTACTED}`;
    if (cfg.prioritaet && cfg.prioritaet !== 'alle') {
      params.prio = cfg.prioritaet;
      where += ` AND prioritaet = @prio`;
    }
  }
  if (cfg.branche && String(cfg.branche).trim()) {
    params.branche = '%' + String(cfg.branche).trim().toLowerCase() + '%';
    where += ` AND LOWER(branche) LIKE @branche`;
  }

  // Kontaktweg: Der E-Mail-Strang braucht eine Adresse, der Telefon-Strang eine Nummer.
  const contact = cfg.requires_email === 'no'
    ? `(email IS NULL OR email = '') AND (COALESCE(telefon_direkt, telefon, '') != '')`
    : cfg.requires_email === 'any'
      // Wurzel-Knoten: nimmt alles auf und verteilt danach selbst nach Kontaktweg.
      ? `(COALESCE(email,'') != '' OR COALESCE(telefon_direkt, telefon, '') != '')`
      : `email IS NOT NULL AND email != ''`;

  const full = `${contact}
       AND COALESCE(track,'voice_agent') = @track
       AND ${where}
       AND id NOT IN (SELECT lead_id FROM workflow_runs WHERE status = 'active')`;
  return { where: full, params };
}

export function enrollCandidates(wf: Workflow, trigger: WorkflowNode, limit: number): Lead[] {
  const { where, params } = candidateQuery(wf, trigger);
  return getDb().prepare(
    `SELECT * FROM leads WHERE ${where}
     ORDER BY CASE prioritaet WHEN 'A' THEN 0 WHEN 'B' THEN 1 ELSE 2 END, score_gesamt DESC
     LIMIT @limit`
  ).all({ ...params, limit }) as Lead[];
}

/** Wie viele Leads warten aktuell darauf, von diesem Start-Knoten aufgenommen zu werden? */
export function pendingCount(wf: Workflow, trigger: WorkflowNode): number {
  const { where, params } = candidateQuery(wf, trigger);
  return (getDb().prepare(`SELECT COUNT(*) n FROM leads WHERE ${where}`).get(params) as { n: number }).n;
}

/** Legt einen Lauf an oder setzt einen bestehenden neu auf. Auch vom Einsortieren genutzt. */
export function startRun(workflowId: string, leadId: string, triggerId: string | null, nodeId: string, dueAt: string): string {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM workflow_runs WHERE workflow_id = ? AND lead_id = ?')
    .get(workflowId, leadId) as { id: string } | undefined;
  const fields = {
    trigger_id: triggerId, node_id: nodeId, status: 'active', due_at: dueAt,
    steps: 0, resume_node: null, watch_off: 0, snooze_until: null, finished_at: null,
  };
  if (existing) {
    const sets = Object.keys(fields).map(k => `${k} = @${k}`).join(', ');
    db.prepare(`UPDATE workflow_runs SET ${sets}, started_at = @__now, updated_at = @__now WHERE id = @__id`)
      .run({ ...fields, __id: existing.id, __now: nowIso() });
    return existing.id;
  }
  const runId = uuid();
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, lead_id, trigger_id, node_id, status, due_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?)`
  ).run(runId, workflowId, leadId, triggerId, nodeId, dueAt);
  return runId;
}

export function enroll(wf: Workflow): number {
  const triggers = wf.graph.nodes.filter(n => n.type === 'trigger');
  let created = 0;
  for (const trigger of triggers) {
    if (created >= MAX_ENROLL_PER_TICK) break;
    const first = nextNodeId(wf.graph, trigger.id);
    if (!first) continue;
    for (const lead of enrollCandidates(wf, trigger, MAX_ENROLL_PER_TICK - created)) {
      if (lead.email && isSuppressed(lead.email)) continue;
      const runId = startRun(wf.id, lead.id, trigger.id, first, nowIso());
      logWorkflow({
        run_id: runId, lead_id: lead.id, lead_name: lead.name, node_id: trigger.id, node_type: 'trigger',
        action: 'In Workflow aufgenommen', detail: `${trigger.title} → ${findNode(wf.graph, first)?.title ?? first}`,
      });
      created++;
      if (created >= MAX_ENROLL_PER_TICK) break;
    }
  }
  return created;
}

