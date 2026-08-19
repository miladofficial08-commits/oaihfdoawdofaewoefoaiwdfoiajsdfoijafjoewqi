import { getDb } from '../db/schema';
import { v4 as uuid } from 'uuid';
import { WorkflowGraph, WorkflowNode, WorkflowEdge, NodeType } from './types';
import { defaultGraph } from './strategy';

export * from './types';
export { defaultGraph } from './strategy';

// ─────────────────────────────────────────────────────────────────────────────
// Speicherung des Strategie-Workflows.
//
// Der Workflow ist ein Graph aus Knoten + Verbindungen. Jeder Lead durchläuft ihn
// als eigener "Run" und steht dabei immer auf genau einem Knoten – daraus ergibt
// sich "welcher Kunde ist in welcher Stage?" ohne Zusatzrechnung.
// ─────────────────────────────────────────────────────────────────────────────

export interface WorkflowRow {
  id: string;
  name: string;
  graph: string;
  enabled: number;
  track: string;
  daily_cap: number;
  window_start: number;
  window_end: number;
  min_gap_s: number;
  created_at: string;
  updated_at: string;
}

export interface Workflow extends Omit<WorkflowRow, 'graph'> {
  graph: WorkflowGraph;
}

export const WORKFLOW_ID = 'main';

/**
 * Leads, die gerade in einer Strategie laufen, gehören dieser Strategie allein.
 * Der alte Auto-Versand und der Follow-up-Worker müssen sie auslassen, sonst
 * bekommt derselbe Betrieb Post aus zwei Richtungen.
 */
export const NOT_IN_ACTIVE_WORKFLOW_SQL =
  `id NOT IN (SELECT lead_id FROM workflow_runs WHERE status = 'active')`;

export function initWorkflowSchema(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflows (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL DEFAULT 'Strategie',
      graph        TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
      enabled      INTEGER NOT NULL DEFAULT 0,
      track        TEXT NOT NULL DEFAULT 'voice_agent',
      daily_cap    INTEGER NOT NULL DEFAULT 40,
      window_start INTEGER NOT NULL DEFAULT 8,
      window_end   INTEGER NOT NULL DEFAULT 20,
      min_gap_s    INTEGER NOT NULL DEFAULT 90,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Ein Run = ein Lead im Workflow. node_id ist die aktuelle Stage.
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id            TEXT PRIMARY KEY,
      workflow_id   TEXT NOT NULL,
      lead_id       TEXT NOT NULL,
      trigger_id    TEXT,
      node_id       TEXT,
      status        TEXT NOT NULL DEFAULT 'active',
      due_at        TEXT,
      steps         INTEGER NOT NULL DEFAULT 0,
      resume_node   TEXT,
      -- watch_off = 1: der Lauf ist bereits in einen Reaktions-Zweig abgebogen und
      -- wird nicht erneut umgeleitet. Abmeldungen greifen trotzdem immer.
      watch_off     INTEGER NOT NULL DEFAULT 0,
      last_reaction_uid INTEGER,
      started_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at   TEXT,
      UNIQUE(workflow_id, lead_id)
    );
    CREATE INDEX IF NOT EXISTS idx_wf_runs_node ON workflow_runs(node_id);
    CREATE INDEX IF NOT EXISTS idx_wf_runs_due  ON workflow_runs(status, due_at);

    -- Lückenloses Protokoll: jede automatische Aktion ist hier nachlesbar.
    CREATE TABLE IF NOT EXISTS workflow_log (
      id          TEXT PRIMARY KEY,
      run_id      TEXT,
      lead_id     TEXT,
      lead_name   TEXT,
      node_id     TEXT,
      node_type   TEXT,
      action      TEXT NOT NULL,
      detail      TEXT,
      level       TEXT NOT NULL DEFAULT 'info',
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_wf_log_created ON workflow_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_wf_log_lead ON workflow_log(lead_id);

    -- Aufgaben: damit eine heiße Spur nie in einer Sackgasse endet.
    CREATE TABLE IF NOT EXISTS tasks (
      id         TEXT PRIMARY KEY,
      lead_id    TEXT,
      kind       TEXT NOT NULL DEFAULT 'call',
      title      TEXT NOT NULL,
      note       TEXT,
      due_at     TEXT,
      status     TEXT NOT NULL DEFAULT 'open',
      source     TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      done_at    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, due_at);

    CREATE TABLE IF NOT EXISTS app_settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  ensureColumns('workflow_runs', {
    // Wiedervorlage: bis zu diesem Zeitpunkt bleibt der Lauf auf dem Snooze-Knoten stehen.
    snooze_until: 'TEXT',
  });
  ensureColumns('leads', {
    // Vom Menschen gesetzte Wiedervorlage ("später kontaktieren", "später anrufen").
    wiedervorlage_at: 'TEXT',
    wiedervorlage_grund: 'TEXT',
  });
  ensureDefaultWorkflow();
  migrateLegacyGraph();
}

/**
 * Hebt eine noch unveränderte Alt-Strategie auf den aktuellen Stand.
 *
 * Die erste Fassung hatte die Reaktions-Weiche 'watch' und kannte weder
 * Telefon-Strang noch manuelle Stages. Wer sie nie bearbeitet hat, würde sonst
 * mit einem Graphen weiterarbeiten, in dem die neuen Stages fehlen – das
 * Einsortieren fände dann nichts. Bearbeitete Graphen bleiben unangetastet.
 */
/**
 * Version der Standard-Strategie. Hochzählen, wenn sich der Aufbau ändert –
 * dann übernehmen laufende Systeme den neuen Baum beim nächsten Start.
 * Läufe werden dabei umgehängt, nicht verworfen (siehe repairRuns).
 */
export const GRAPH_VERSION = 4;

function migrateLegacyGraph(): void {
  const db = getDb();
  const gespeicherteVersion = Number(getSetting('graph_version', '0')) || 0;
  const rows = db.prepare('SELECT id, graph FROM workflows').all() as Array<{ id: string; graph: string }>;
  for (const row of rows) {
    let ids: string[];
    try { ids = (JSON.parse(row.graph).nodes || []).map((n: WorkflowNode) => n.id); } catch { continue; }
    // Zwei Generationen koennen veraltet sein: die allererste (Weiche hiess 'watch')
    // und die zweite ohne Neuanlauf-Spur. Beide werden angehoben, solange dort noch
    // keine Leads laufen.
    // Merkmal der jeweils aktuellen Fassung ist der Einstiegsknoten 'lead_liste'.
    // Alles davor gilt als veraltet und wird angehoben, solange dort keine Leads laufen.
    // Zwei Gründe für eine Auffrischung:
    //   1. Der Graph stammt aus einer Vorgängerfassung (Merkmal: keine Wurzel 'kunden').
    //   2. Die Standard-Strategie wurde seither weiterentwickelt (Versionsnummer).
    // Ohne Nummer 2 käme eine verbesserte Strategie nie auf einem laufenden System an.
    const alteFassung = !ids.includes('kunden')
      && ['watch', 'weiche', 'start', 'lead_liste', 'mail1'].some(i => ids.includes(i));
    const isLegacy = alteFassung || gespeicherteVersion < GRAPH_VERSION;
    if (!isLegacy) continue;
    const next = defaultGraph();
    db.prepare(`UPDATE workflows SET graph = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(JSON.stringify(next), row.id);
    const moved = repairRuns(row.id, next);
    console.log('[workflow] Strategie "' + row.id + '" auf Stand ' + GRAPH_VERSION + ' gehoben'
      + (moved ? ' – ' + moved + ' laufende Leads umgehängt' : ''));
  }
  setSetting('graph_version', String(GRAPH_VERSION));
}

/**
 * Nach einer Graph-Migration: Läufe retten, deren Knoten es nicht mehr gibt.
 *
 * Ein Lauf zeigt auf eine node_id. Verschwindet die, stünde der Lead im Nichts und
 * würde beim nächsten Tick mit Fehler beendet. Deshalb werden bekannte Umbenennungen
 * direkt umgehängt, alles andere landet sichtbar auf der Warte-Stage.
 */
const NODE_RENAMES: Record<string, string> = {
  // Vorgängerfassungen → Stammbaum
  start: 'neu_mail1', lead_liste: 'neu_mail1', mail1: 'neu_mail1',
  wait1: 'neu_wait1', fu1: 'neu_mail2', wait2: 'neu_wait2', fu2: 'neu_mail3',
  wait3: 'neu_wait3', fu3: 'neu_mail4', wait4: 'neu_wait4', keine_antwort: 'neu_ende',
  na_mail1: 'alt_mail1', na_wait1: 'alt_wait1', na_mail2: 'alt_mail2',
  na_wait2: 'alt_wait2', na_mail3: 'alt_mail3', na_wait3: 'alt_wait3', na_ende: 'alt_ende',
  start_tel: 'anruf', lead_liste_tel: 'anruf', tel_mail: 'tel_mail1',
  interessiert: 'int_start', termin_mail: 'int_mail', wait_termin: 'int_wait',
  termin_offen: 'int_termin', wv_termin: 'int_wv', gespraech: 'int_gespraech',
  angebot: 'int_angebot', kunde: 'int_kunde', kein_kunde: 'int_kein_kunde',
  sperren: 'alt_sperren', kein_interesse: 'alt_kein', urlaub: 'alt_urlaub',
  spaeter: 'alt_wv', falscher_ap: 'alt_sonder', bounce_pruefen: 'alt_sonder',
  wv_anruf: 'anruf_wv', notiz_wv: 'tel_sonder',
  // Telefon-Ast: eine Einstiegsmail wurde zu dreien (je Anrufergebnis)
  tel_mail1: 'tel_nicht_erreicht',

  // Stand 4: Jede Weiche hat eigene Folgeknoten, jeder Ast eine eigene
  // Terminstrecke. Die frueher geteilten Knoten wandern in den Bestands-Ast –
  // dort steckt die Masse der Leads.
  int_start: 'alt_int1', int_mail: 'alt_termin_mail', int_wait: 'alt_termin_wait',
  int_termin: 'alt_termin', int_wv: 'alt_termin_wv', int_gespraech: 'alt_gespraech',
  int_angebot: 'alt_angebot', int_kunde: 'alt_kunde', int_kein_kunde: 'alt_kein_kunde',
  alt_int: 'alt_int1', neu_int: 'neu_int1', tel_int: 'tel_int1',
  alt_kein: 'alt_kein1', neu_kein: 'neu_kein1', tel_kein: 'tel_kein1',
  alt_sperren: 'alt_kein1', neu_sperren: 'neu_kein1', tel_sperren: 'tel_kein1',
  alt_sonder: 'alt_pruef1', neu_sonder: 'neu_pruef1', tel_sonder: 'tel_pruef1',
};

function repairRuns(workflowId: string, graph: WorkflowGraph): number {
  const db = getDb();
  const known = new Set(graph.nodes.map(n => n.id));
  const fallback = known.has('alt_ende') ? 'alt_ende' : (graph.nodes[0]?.id ?? null);
  const runs = db.prepare(
    `SELECT id, node_id FROM workflow_runs WHERE workflow_id = ? AND status = 'active'`
  ).all(workflowId) as Array<{ id: string; node_id: string | null }>;

  let moved = 0;
  const upd = db.prepare(`UPDATE workflow_runs SET node_id = ?, updated_at = datetime('now') WHERE id = ?`);
  for (const r of runs) {
    if (r.node_id && known.has(r.node_id)) continue;
    const target = (r.node_id && NODE_RENAMES[r.node_id] && known.has(NODE_RENAMES[r.node_id]))
      ? NODE_RENAMES[r.node_id]
      : fallback;
    if (!target) continue;
    upd.run(target, r.id);
    moved++;
  }
  return moved;
}

function ensureColumns(table: string, columns: Record<string, string>): void {
  const db = getDb();
  const existing = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name)
  );
  for (const [name, def] of Object.entries(columns)) {
    if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
  }
}

export function getSetting(key: string, fallback = ''): string {
  const row = getDb().prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? fallback;
}

export function setSetting(key: string, value: string): void {
  getDb().prepare(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

function ensureDefaultWorkflow(): void {
  const db = getDb();
  const exists = db.prepare('SELECT 1 FROM workflows WHERE id = ?').get(WORKFLOW_ID);
  if (exists) return;
  db.prepare(
    `INSERT INTO workflows (id, name, graph, enabled, track) VALUES (?, ?, ?, 0, 'voice_agent')`
  ).run(WORKFLOW_ID, 'Standard-Strategie', JSON.stringify(defaultGraph()));
}

export function getWorkflow(id = WORKFLOW_ID): Workflow {
  initWorkflowSchema();
  const row = getDb().prepare('SELECT * FROM workflows WHERE id = ?').get(id) as WorkflowRow | undefined;
  if (!row) throw new Error('Workflow nicht gefunden');
  return { ...row, graph: parseGraph(row.graph) };
}

function parseGraph(raw: string): WorkflowGraph {
  try {
    const parsed = JSON.parse(raw) as WorkflowGraph;
    return { nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [], edges: Array.isArray(parsed.edges) ? parsed.edges : [] };
  } catch {
    return { nodes: [], edges: [] };
  }
}

export interface WorkflowPatch {
  name?: string;
  graph?: WorkflowGraph;
  enabled?: boolean;
  track?: string;
  daily_cap?: number;
  window_start?: number;
  window_end?: number;
  min_gap_s?: number;
}

const clamp = (v: unknown, fallback: number, min: number, max: number): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
};

export function saveWorkflow(patch: WorkflowPatch, id = WORKFLOW_ID): Workflow {
  const cur = getWorkflow(id);
  const next = {
    id,
    name: patch.name?.trim() || cur.name,
    graph: JSON.stringify(patch.graph ? sanitizeGraph(patch.graph) : cur.graph),
    enabled: patch.enabled != null ? (patch.enabled ? 1 : 0) : cur.enabled,
    track: patch.track || cur.track,
    daily_cap: clamp(patch.daily_cap, cur.daily_cap, 1, 200),
    window_start: clamp(patch.window_start, cur.window_start, 0, 23),
    window_end: clamp(patch.window_end, cur.window_end, 1, 24),
    min_gap_s: clamp(patch.min_gap_s, cur.min_gap_s, 15, 3600),
    now: new Date().toISOString(),
  };
  getDb().prepare(
    `UPDATE workflows SET name=@name, graph=@graph, enabled=@enabled, track=@track,
       daily_cap=@daily_cap, window_start=@window_start, window_end=@window_end,
       min_gap_s=@min_gap_s, updated_at=@now WHERE id=@id`
  ).run(next);
  // Startzeitpunkt der Aufwärmphase merken: ab hier wächst das Tagesvolumen.
  if (next.enabled && !cur.enabled && !getSetting('wf_started_at')) {
    setSetting('wf_started_at', next.now);
  }
  return getWorkflow(id);
}

const VALID_TYPES: NodeType[] = [
  'trigger', 'email', 'wait', 'check', 'stage', 'call', 'snooze', 'task', 'status', 'suppress', 'pause', 'stop',
];

/** Nimmt nur wohlgeformte Knoten/Kanten an – ein kaputter Graph darf die Engine nicht anhalten. */
export function sanitizeGraph(graph: WorkflowGraph): WorkflowGraph {
  const nodes: WorkflowNode[] = [];
  const seen = new Set<string>();
  for (const n of graph.nodes || []) {
    if (!n || typeof n.id !== 'string' || !n.id.trim()) continue;
    if (!VALID_TYPES.includes(n.type)) continue;
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    nodes.push({
      id: n.id,
      type: n.type,
      title: String(n.title ?? '').slice(0, 80) || n.type,
      x: Number.isFinite(Number(n.x)) ? Math.round(Number(n.x)) : 0,
      y: Number.isFinite(Number(n.y)) ? Math.round(Number(n.y)) : 0,
      config: n.config && typeof n.config === 'object' ? n.config : {},
    });
  }
  const edges: WorkflowEdge[] = [];
  const edgeSeen = new Set<string>();
  for (const e of graph.edges || []) {
    if (!e || !seen.has(e.from) || !seen.has(e.to)) continue;
    const port = String(e.port || 'out');
    const key = `${e.from}:${port}->${e.to}`;
    if (edgeSeen.has(key)) continue;
    edgeSeen.add(key);
    edges.push({ id: key, from: e.from, port, to: e.to });
  }
  return { nodes, edges };
}

export function nextNodeId(graph: WorkflowGraph, from: string, port = 'out'): string | null {
  const e = graph.edges.find(x => x.from === from && x.port === port);
  return e ? e.to : null;
}

export function findNode(graph: WorkflowGraph, id: string | null): WorkflowNode | null {
  if (!id) return null;
  return graph.nodes.find(n => n.id === id) ?? null;
}

export function logWorkflow(entry: {
  run_id?: string | null; lead_id?: string | null; lead_name?: string | null;
  node_id?: string | null; node_type?: string | null; action: string; detail?: string | null;
  level?: 'info' | 'send' | 'warn' | 'hot';
}): void {
  getDb().prepare(
    `INSERT INTO workflow_log (id, run_id, lead_id, lead_name, node_id, node_type, action, detail, level)
     VALUES (@id, @run_id, @lead_id, @lead_name, @node_id, @node_type, @action, @detail, @level)`
  ).run({
    id: uuid(),
    run_id: entry.run_id ?? null,
    lead_id: entry.lead_id ?? null,
    lead_name: entry.lead_name ?? null,
    node_id: entry.node_id ?? null,
    node_type: entry.node_type ?? null,
    action: entry.action,
    detail: entry.detail ?? null,
    level: entry.level ?? 'info',
  });
}

// ── Mehrere Strategien ──────────────────────────────────────────────────────
// Wie bei den E-Mail-Vorlagen: beliebig viele Strategien nebeneinander, jede
// einzeln aktivierbar. Ein Lead ist dabei immer nur in EINER Strategie.

export function listWorkflows(): Workflow[] {
  initWorkflowSchema();
  const rows = getDb().prepare('SELECT * FROM workflows ORDER BY created_at ASC').all() as WorkflowRow[];
  return rows.map(row => ({ ...row, graph: parseGraph(row.graph) }));
}

export function createWorkflow(name: string, copyFrom?: string): Workflow {
  initWorkflowSchema();
  const id = 'wf_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const base = copyFrom ? getWorkflow(copyFrom) : null;
  getDb().prepare(
    `INSERT INTO workflows (id, name, graph, enabled, track, daily_cap, window_start, window_end, min_gap_s)
     VALUES (@id, @name, @graph, 0, @track, @daily_cap, @window_start, @window_end, @min_gap_s)`
  ).run({
    id,
    name: (name || 'Neue Strategie').slice(0, 80),
    graph: JSON.stringify(base ? base.graph : { nodes: [], edges: [] }),
    track: base?.track ?? 'voice_agent',
    daily_cap: base?.daily_cap ?? 40,
    window_start: base?.window_start ?? 8,
    window_end: base?.window_end ?? 20,
    min_gap_s: base?.min_gap_s ?? 90,
  });
  return getWorkflow(id);
}

export function deleteWorkflow(id: string): void {
  if (id === WORKFLOW_ID) throw new Error('Die Standard-Strategie kann nicht gelöscht werden');
  const db = getDb();
  db.prepare(`UPDATE workflow_runs SET status = 'stopped', finished_at = datetime('now') WHERE workflow_id = ? AND status = 'active'`).run(id);
  db.prepare('DELETE FROM workflows WHERE id = ?').run(id);
}

/**
 * Wie viele Mails darf die Strategie HEUTE senden?
 *
 * Ein Konto, das plötzlich das Zehnfache verschickt, landet im Spam. Deshalb
 * wächst das Volumen automatisch: Start 60/Tag, +30 pro Woche, gedeckelt durch
 * die eingestellte Obergrenze. Niemand muss daran denken.
 */
export const WARMUP_START = 60;
export const WARMUP_STEP_PER_WEEK = 30;

export function effectiveDailyCap(wf: Workflow): { cap: number; ramping: boolean; weeks: number } {
  const started = getSetting('wf_started_at');
  if (!started) return { cap: wf.daily_cap, ramping: false, weeks: 0 };
  const ms = Date.now() - new Date(started).getTime();
  const weeks = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / (7 * 86_400_000))) : 0;
  const ramped = WARMUP_START + weeks * WARMUP_STEP_PER_WEEK;
  const cap = Math.min(wf.daily_cap, ramped);
  return { cap, ramping: cap < wf.daily_cap, weeks };
}

/** Alle aktiven Strategien – die Engine arbeitet sie in einem Tick nacheinander ab. */
export function activeWorkflows(): Workflow[] {
  return listWorkflows().filter(w => w.enabled);
}
