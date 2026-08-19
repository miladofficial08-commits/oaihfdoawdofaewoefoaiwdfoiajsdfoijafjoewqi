import { FastifyInstance } from 'fastify';
import { getDb } from '../db/schema';
import {
  getWorkflow, saveWorkflow, defaultGraph, sanitizeGraph, initWorkflowSchema,
  listWorkflows, createWorkflow, deleteWorkflow, findNode, nodeOutcomes, nodeTone, nodePorts,
  getSetting, setSetting, WorkflowGraph, Workflow, PORT_LABELS, PORT_TONES, CHECK_PORTS, WORKFLOW_ID,
} from './schema';
import { runWorkflowTick, advanceLeadManually, snoozeLead, runLeadNow, activeRunForLead, moveLeadToNode } from './engine';
import { pendingCount } from './enroll';
import { backfillWorkflow } from './backfill';
import { workflowHealth } from './health';
import { suppressionCount } from './optout';

// HTTP-Schicht der Strategie: Strategien verwalten, Graph speichern, sehen welcher
// Kunde auf welcher Stage steht, einzelne Leads von Hand weiterschieben.

interface NodeCount { node_id: string; n: number }

export function nodeCounts(workflowId: string): Record<string, number> {
  const rows = getDb().prepare(
    `SELECT node_id, COUNT(*) n FROM workflow_runs
     WHERE workflow_id = ? AND status = 'active' AND node_id IS NOT NULL
     GROUP BY node_id`
  ).all(workflowId) as NodeCount[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.node_id] = r.n;
  return out;
}

/** Wartende Leads je Start-Knoten – zeigt, dass frisch importierte Leads wirklich anschließen. */
function pendingCounts(wf: Workflow): Record<string, number> {
  const out: Record<string, number> = {};
  for (const n of wf.graph.nodes) {
    if (n.type !== 'trigger') continue;
    try { out[n.id] = pendingCount(wf, n); } catch { out[n.id] = 0; }
  }
  return out;
}

export function workflowStats(workflowId: string) {
  const db = getDb();
  const one = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;
  return {
    active: one(`SELECT COUNT(*) n FROM workflow_runs WHERE workflow_id = ? AND status = 'active'`, workflowId),
    done: one(`SELECT COUNT(*) n FROM workflow_runs WHERE workflow_id = ? AND status = 'done'`, workflowId),
    stopped: one(`SELECT COUNT(*) n FROM workflow_runs WHERE workflow_id = ? AND status = 'stopped'`, workflowId),
    sent_today: one(
      `SELECT COUNT(*) n FROM sent_emails WHERE success = 1 AND campaign LIKE 'wf-%'
       AND sent_at >= datetime('now','start of day','localtime')`
    ),
    sent_total: one(`SELECT COUNT(*) n FROM sent_emails WHERE success = 1 AND campaign LIKE 'wf-%'`),
    // Mails aus der Zeit VOR der Strategie. Ohne diese Zahl wirkt das Dashboard so,
    // als sei nie etwas versendet worden – die alte Kampagne steckt aber im Bestand.
    legacy_sent: one(`SELECT COUNT(*) n FROM sent_emails WHERE success = 1 AND (campaign IS NULL OR campaign NOT LIKE 'wf-%')`),
    open_tasks: one(`SELECT COUNT(*) n FROM tasks WHERE status = 'open'`),
    due_tasks: one(`SELECT COUNT(*) n FROM tasks WHERE status = 'open' AND due_at <= datetime('now')`),
    suppressed: suppressionCount(),
  };
}

function payload(wf: Workflow) {
  const db = getDb();
  return {
    ...wf,
    counts: nodeCounts(wf.id),
    pending: pendingCounts(wf),
    stats: workflowStats(wf.id),
    cal_link: getSetting('cal_link', ''),
    port_labels: PORT_LABELS,
    port_tones: PORT_TONES,
    check_ports: CHECK_PORTS,
    // Darstellung: Farbe + Ausgänge kommen aus derselben Quelle wie die Engine.
    node_meta: Object.fromEntries(wf.graph.nodes.map(n => [n.id, { tone: nodeTone(n), ports: nodePorts(n) }])),
    strategies: listWorkflows().map(w => ({
      id: w.id, name: w.name, enabled: w.enabled, track: w.track,
      nodes: w.graph.nodes.length,
      active_leads: (db.prepare(`SELECT COUNT(*) n FROM workflow_runs WHERE workflow_id = ? AND status = 'active'`).get(w.id) as { n: number }).n,
      removable: w.id !== WORKFLOW_ID,
    })),
  };
}

const resolveId = (raw: unknown): string => String(raw || '').trim() || WORKFLOW_ID;

export async function registerWorkflowRoutes(app: FastifyInstance) {
  initWorkflowSchema();

  app.get<{ Querystring: { id?: string } }>('/api/workflow', async (req, reply) => {
    try { return payload(getWorkflow(resolveId(req.query.id))); }
    catch { return reply.status(404).send({ error: 'Strategie nicht gefunden' }); }
  });

  app.get('/api/workflows', async () => ({
    strategies: listWorkflows().map(w => ({ id: w.id, name: w.name, enabled: w.enabled, track: w.track, nodes: w.graph.nodes.length })),
  }));

  app.post<{ Body: { name?: string; copyFrom?: string } }>('/api/workflows', async (req) =>
    payload(createWorkflow(String(req.body?.name || 'Neue Strategie'), req.body?.copyFrom)));

  app.delete<{ Params: { id: string } }>('/api/workflows/:id', async (req, reply) => {
    try { deleteWorkflow(req.params.id); return { ok: true }; }
    catch (err) { return reply.status(400).send({ ok: false, error: err instanceof Error ? err.message : 'Löschen fehlgeschlagen' }); }
  });

  app.put<{ Querystring: { id?: string }; Body: {
    graph?: WorkflowGraph; enabled?: boolean; name?: string; track?: string;
    daily_cap?: number; window_start?: number; window_end?: number; min_gap_s?: number;
  } }>('/api/workflow', async (req, reply) => {
    try { return payload(saveWorkflow(req.body || {}, resolveId(req.query.id))); }
    catch { return reply.status(404).send({ error: 'Strategie nicht gefunden' }); }
  });

  app.post<{ Querystring: { id?: string } }>('/api/workflow/reset', async (req) =>
    payload(saveWorkflow({ graph: sanitizeGraph(defaultGraph()) }, resolveId(req.query.id))));

  app.put<{ Body: { cal_link?: string } }>('/api/workflow/settings', async (req) => {
    const link = String(req.body?.cal_link ?? '').trim();
    if (link && !/^https?:\/\//i.test(link)) return { ok: false, error: 'Bitte eine vollständige URL angeben (mit https://).' };
    setSetting('cal_link', link);
    return { ok: true, cal_link: link };
  });

  // ── ① Bestandsdaten einsortieren ──────────────────────────────────────────
  app.post<{ Querystring: { id?: string }; Body: { apply?: boolean } }>('/api/workflow/backfill', async (req, reply) => {
    try {
      const wf = getWorkflow(resolveId(req.query.id));
      const result = backfillWorkflow(wf, !req.body?.apply);
      return { ...result, ...(req.body?.apply ? payload(wf) : {}) };
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'Einsortieren fehlgeschlagen' });
    }
  });

  // ── ② Strategie übernehmen ────────────────────────────────────────────────
  // Ab hier ist ausschließlich diese Strategie zuständig: sie wird aktiviert,
  // konkurrierende Strategien und die alte Parallel-Mechanik (Auto-Kampagnen,
  // Follow-up-Worker) werden gestoppt, der Bestand wird einsortiert.
  app.post<{ Querystring: { id?: string }; Body: { skipBackfill?: boolean } }>('/api/workflow/adopt', async (req, reply) => {
    const db = getDb();
    let wf: Workflow;
    try { wf = getWorkflow(resolveId(req.query.id)); }
    catch { return reply.status(404).send({ error: 'Strategie nicht gefunden' }); }

    const others = listWorkflows().filter(w => w.id !== wf.id && w.enabled);
    for (const o of others) saveWorkflow({ enabled: false }, o.id);

    const jobs = db.prepare(`SELECT id, name FROM send_jobs WHERE status = 'running'`).all() as Array<{ id: string; name: string }>;
    for (const j of jobs) {
      db.prepare(`UPDATE send_jobs SET status = 'stopped', note = 'Gestoppt: Strategie übernommen' WHERE id = ?`).run(j.id);
    }

    const fuWasOn = (db.prepare(`SELECT enabled FROM followup_config WHERE id = 1`).get() as { enabled: number } | undefined)?.enabled === 1;
    if (fuWasOn) db.prepare(`UPDATE followup_config SET enabled = 0, updated_at = datetime('now') WHERE id = 1`).run();

    // Fertig vorbereitete Mails aus dem alten System liegen in der Warteschlange
    // und wuerden beim naechsten Tick rausgehen - mit dem alten Text. Sie werden
    // abgeraeumt, nicht gesendet. Ab hier schreibt nur noch die Strategie.
    const geplant = db.prepare(
      `UPDATE scheduled_emails SET status = 'cancelled', error = 'Abgeraeumt: Strategie uebernommen',
       updated_at = datetime('now') WHERE status IN ('scheduled','processing')`
    ).run().changes;

    const backfill = req.body?.skipBackfill ? null : backfillWorkflow(wf, false);
    const saved = saveWorkflow({ enabled: true }, wf.id);

    return {
      ok: true,
      strategie: saved.name,
      deaktivierte_strategien: others.map(o => o.name),
      gestoppte_kampagnen: jobs.map(j => j.name),
      followup_worker_gestoppt: fuWasOn,
      geplante_mails_abgeraeumt: geplant,
      einsortiert: backfill ? backfill.assigned : 0,
      ...payload(saved),
    };
  });

  // ── Stage → welche Kunden stehen hier? ────────────────────────────────────
  app.get<{ Params: { nodeId: string }; Querystring: { limit?: string; id?: string } }>(
    '/api/workflow/node/:nodeId/leads',
    async (req) => {
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
      const rows = getDb().prepare(
        `SELECT r.id AS run_id, r.lead_id, r.due_at, r.snooze_until, r.started_at, r.steps,
                l.name, l.branche, l.stadt, l.email, l.telefon, l.telefon_direkt, l.geschaeftsfuehrer,
                l.status, l.prioritaet, l.wiedervorlage_at
         FROM workflow_runs r JOIN leads l ON l.id = r.lead_id
         WHERE r.node_id = ? AND r.workflow_id = ? AND r.status = 'active'
         ORDER BY COALESCE(r.due_at, r.started_at) ASC LIMIT ?`
      ).all(req.params.nodeId, resolveId(req.query.id), limit);
      return { node_id: req.params.nodeId, leads: rows };
    }
  );

  // ── Lead-Detail: alles zu einem Lead an einer Stelle ──────────────────────
  app.get<{ Params: { leadId: string } }>('/api/workflow/lead/:leadId', async (req, reply) => {
    const db = getDb();
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.leadId);
    if (!lead) return reply.status(404).send({ error: 'Lead nicht gefunden' });

    const run = activeRunForLead(req.params.leadId);
    let node = null, outcomes: unknown[] = [], workflowName = '';
    if (run) {
      try {
        const wf = getWorkflow(run.workflow_id);
        workflowName = wf.name;
        const n = findNode(wf.graph, run.node_id);
        if (n) {
          node = { id: n.id, title: n.title, type: n.type, tone: nodeTone(n) };
          outcomes = nodeOutcomes(n);
        }
      } catch { /* Strategie gelöscht – Lead trotzdem anzeigen */ }
    }

    const emails = db.prepare(
      `SELECT id, subject, body, campaign, sent_at, success, delivery_status, error
       FROM sent_emails WHERE lead_id = ? ORDER BY sent_at DESC LIMIT 40`
    ).all(req.params.leadId);
    const replies = db.prepare(
      `SELECT uid, subject, snippet, category, received_at, created_at
       FROM inbound_replies WHERE lead_id = ? ORDER BY COALESCE(received_at, created_at) DESC LIMIT 40`
    ).all(req.params.leadId);
    const events = db.prepare(
      `SELECT event_type, channel, status, user, note, created_at
       FROM outreach_events WHERE lead_id = ? ORDER BY created_at DESC LIMIT 60`
    ).all(req.params.leadId);
    const tasks = db.prepare(
      `SELECT id, title, kind, note, due_at, status FROM tasks WHERE lead_id = ? ORDER BY created_at DESC LIMIT 20`
    ).all(req.params.leadId);
    const log = db.prepare(
      `SELECT action, detail, level, created_at FROM workflow_log WHERE lead_id = ? ORDER BY created_at DESC LIMIT 30`
    ).all(req.params.leadId);

    return { lead, run: run ?? null, node, outcomes, workflow: workflowName, emails, replies, events, tasks, log };
  });

  // Ergebnis einer Stage wählen (Anrufergebnis, Termin gebucht, …)
  app.post<{ Params: { leadId: string }; Body: { port: string; note?: string; wiedervorlage?: string } }>(
    '/api/workflow/lead/:leadId/advance',
    async (req) => {
      const { port, note, wiedervorlage } = req.body || {};
      if (wiedervorlage) snoozeLead(req.params.leadId, wiedervorlage, note);
      return advanceLeadManually(req.params.leadId, String(port || ''), note);
    }
  );

  app.post<{ Params: { leadId: string }; Body: { until: string; grund?: string } }>(
    '/api/workflow/lead/:leadId/snooze',
    async (req) => snoozeLead(req.params.leadId, String(req.body?.until || ''), req.body?.grund)
  );

  app.post<{ Params: { leadId: string } }>('/api/workflow/lead/:leadId/run-now', async (req) =>
    runLeadNow(req.params.leadId));

  // Auf eine beliebige Stage schieben – z. B. auf den Parkplatz "Sonstige".
  app.post<{ Params: { leadId: string }; Body: { nodeId: string; note?: string } }>(
    '/api/workflow/lead/:leadId/move',
    async (req) => moveLeadToNode(req.params.leadId, String(req.body?.nodeId || ''), req.body?.note)
  );

  app.post<{ Params: { leadId: string }; Body: { note: string } }>('/api/workflow/lead/:leadId/note', async (req) => {
    const note = String(req.body?.note || '').trim();
    if (!note) return { ok: false, error: 'Notiz ist leer' };
    getDb().prepare(
      `INSERT INTO outreach_events (id, lead_id, event_type, channel, user, note)
       VALUES (lower(hex(randomblob(16))), ?, 'note', 'workflow', 'mensch', ?)`
    ).run(req.params.leadId, note);
    return { ok: true };
  });

  // Wächter: läuft die E-Mail-Abteilung gerade – und wenn nicht, warum?
  app.get<{ Querystring: { id?: string } }>('/api/workflow/health', async (req, reply) => {
    try { return workflowHealth(getWorkflow(resolveId(req.query.id))); }
    catch { return reply.status(404).send({ error: 'Strategie nicht gefunden' }); }
  });

  app.get<{ Querystring: { limit?: string; lead?: string } }>('/api/workflow/log', async (req) => {
    const limit = Math.min(300, Math.max(1, Number(req.query.limit) || 60));
    const rows = req.query.lead
      ? getDb().prepare(`SELECT * FROM workflow_log WHERE lead_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(req.query.lead, limit)
      : getDb().prepare(`SELECT * FROM workflow_log ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(limit);
    return { entries: rows };
  });

  app.get<{ Querystring: { status?: string } }>('/api/tasks', async (req) => {
    const status = req.query.status === 'done' ? 'done' : 'open';
    const rows = getDb().prepare(
      `SELECT t.*, l.name AS lead_name, l.branche, l.stadt, l.email, l.telefon, l.telefon_direkt
       FROM tasks t LEFT JOIN leads l ON l.id = t.lead_id
       WHERE t.status = ? ORDER BY COALESCE(t.due_at, t.created_at) ASC LIMIT 200`
    ).all(status);
    return { tasks: rows };
  });

  app.post<{ Params: { id: string } }>('/api/tasks/:id/done', async (req) => {
    getDb().prepare(`UPDATE tasks SET status = 'done', done_at = datetime('now') WHERE id = ?`).run(req.params.id);
    return { ok: true };
  });

  app.post<{ Querystring: { id?: string } }>('/api/workflow/tick', async (req) => {
    const r = await runWorkflowTick();
    return { ...r, ...payload(getWorkflow(resolveId(req.query.id))) };
  });

  app.post<{ Body: { leadId: string } }>('/api/workflow/stop-lead', async (req) => {
    const leadId = String(req.body?.leadId || '');
    if (!leadId) return { ok: false, error: 'leadId fehlt' };
    getDb().prepare(
      `UPDATE workflow_runs SET status = 'stopped', finished_at = datetime('now'), updated_at = datetime('now')
       WHERE lead_id = ? AND status = 'active'`
    ).run(leadId);
    return { ok: true };
  });
}
