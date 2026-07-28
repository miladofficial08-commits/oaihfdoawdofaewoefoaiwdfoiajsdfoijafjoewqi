import { getDb } from '../db/schema';
import { runPipeline } from '../pipeline';
import { verticalPresets } from '../config/markets';
import { OUTREACH_TEMPLATE_IDS } from './template';
import { setFollowupConfig, getFollowupConfig } from './followup-sender';
import { v4 as uuid } from 'uuid';

/**
 * Täglicher Motor (Hebel 1): läuft serverseitig und hält die Outreach-Maschine
 * ohne manuelles Zutun am Laufen. Zweigleisige Strategie:
 *  - Send-Job über ALLE Branchen  → erntet den bestehenden Handwerker-Bestand ab
 *  - Täglicher Dental-Scrape       → baut die höhermargige Pipeline neu auf
 *
 * Aktivierung bewusst über die Env-Variable DAILY_ENGINE (Kill-Switch). Ein
 * normaler Deploy löst also nie ungewollt Versand/Scrape aus – der Nutzer schaltet
 * die Maschine einmal in Railway scharf, danach läuft sie hands-off.
 *
 * Steuerbare Env-Variablen (alle optional, sinnvolle Defaults):
 *   DAILY_ENGINE            = on|off        (Hauptschalter)
 *   DAILY_ENGINE_SCRAPE     = 50            (neue Leads/Tag, max 200)
 *   DAILY_ENGINE_EMAILS     = 50            (Tages-Deckel Versand; Warmup rampt darauf hoch)
 *   DAILY_ENGINE_VERTICALS  = zahnarzt,kieferchirurg   (Preset-IDs, rotieren täglich)
 *   DAILY_ENGINE_CITIES     = Duesseldorf,Koeln,...    (rotieren täglich)
 */

const CHECK_MS = 30 * 60 * 1000; // alle 30 Min prüfen, ob heute schon gescraped wurde
const ALLOWED_DAILY = [30, 50, 100, 150, 200];

function isEnabled(): boolean {
  return /^(1|true|on|yes|ja)$/i.test((process.env.DAILY_ENGINE || '').trim());
}

interface EngineConfig {
  scrapePerDay: number;
  emailDailyLimit: number;
  scrapeVerticals: string[];
  scrapeCities: string[];
}

function loadConfig(): EngineConfig {
  const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
  const list = (v: string | undefined, d: string[]) => { const a = (v || '').split(',').map(s => s.trim()).filter(Boolean); return a.length ? a : d; };
  const emails = num(process.env.DAILY_ENGINE_EMAILS, 50);
  return {
    scrapePerDay: Math.min(200, num(process.env.DAILY_ENGINE_SCRAPE, 50)),
    emailDailyLimit: ALLOWED_DAILY.includes(emails) ? emails : 50,
    scrapeVerticals: list(process.env.DAILY_ENGINE_VERTICALS, ['zahnarzt', 'kieferchirurg']),
    scrapeCities: list(process.env.DAILY_ENGINE_CITIES, [
      'Duesseldorf', 'Koeln', 'Essen', 'Dortmund', 'Duisburg', 'Wuppertal', 'Bochum', 'Neuss', 'Moenchengladbach', 'Bonn',
    ]),
  };
}

// ── kleiner Key/Value-Zustand, damit Scrape genau 1×/Tag läuft (überlebt Neustarts) ──
function ensureStateTable(): void {
  getDb().exec(`CREATE TABLE IF NOT EXISTS engine_state (key TEXT PRIMARY KEY, value TEXT)`);
}
function stateGet(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM engine_state WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : null;
}
function stateSet(key: string, value: string): void {
  getDb().prepare(
    `INSERT INTO engine_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

function todayLocal(): string {
  return (getDb().prepare(`SELECT date('now','localtime') d`).get() as { d: string }).d;
}

/** Stellt genau EINEN laufenden Send-Job über alle Branchen sicher (idempotent). */
function ensureSendJob(cfg: EngineConfig): void {
  const db = getDb();
  const running = (db.prepare(`SELECT COUNT(*) n FROM send_jobs WHERE status = 'running'`).get() as { n: number }).n;
  if (running > 0) return; // es läuft bereits ein Job – nicht doppeln

  const id = uuid();
  db.prepare(
    `INSERT INTO send_jobs (id, name, vertical_id, branche_terms, template_ids, total_target, daily_limit, min_gap_s, max_gap_s, window_start, window_end, status, note, next_send_at)
     VALUES (@id, @name, NULL, NULL, @template_ids, @total_target, @daily_limit, @min_gap_s, @max_gap_s, @window_start, @window_end, 'running', @note, datetime('now'))`
  ).run({
    id,
    name: 'Tagesmotor – Alle Branchen (A/B-Rotation)',
    template_ids: JSON.stringify(OUTREACH_TEMPLATE_IDS),
    total_target: 5000,
    daily_limit: cfg.emailDailyLimit,
    min_gap_s: 90,   // ruhiger Takt (Reputationsschutz), Streuung bis max_gap
    max_gap_s: 240,
    window_start: 8, // 8–20 Uhr: Handwerker/Praxen lesen früh + nach Feierabend
    window_end: 20,
    note: 'Automatisch vom Tagesmotor angelegt',
  });
  console.log('[daily-engine] Send-Job angelegt (Alle Branchen, Warmup-Rampe aktiv)');
}

/** Aktiviert die Follow-up-Sequenz genau einmal (respektiert spätere manuelle Deaktivierung). */
function ensureFollowupInitialized(): void {
  if (stateGet('followup_initialized') === '1') return;
  const cfg = getFollowupConfig();
  if (!cfg.enabled) {
    setFollowupConfig({ enabled: true });
    console.log('[daily-engine] Follow-up-Sequenz initial aktiviert');
  }
  stateSet('followup_initialized', '1');
}

/** Ein Scrape-Lauf pro Tag: rotierende Branche × Stadt aus der Dental-Pipeline. */
async function dailyScrape(cfg: EngineConfig): Promise<void> {
  if (cfg.scrapePerDay <= 0) return;
  if (stateGet('last_scrape_date') === todayLocal()) return; // heute schon erledigt

  const cursor = Number(stateGet('rotation_cursor') || '0');
  const presetId = cfg.scrapeVerticals[cursor % cfg.scrapeVerticals.length];
  const preset = verticalPresets.find(v => v.id === presetId);
  const branche = preset ? preset.searchTerms[0] : presetId;
  const stadt = cfg.scrapeCities[cursor % cfg.scrapeCities.length];

  console.log(`[daily-engine] Scrape #${cursor}: ${branche} in ${stadt} (max ${cfg.scrapePerDay})`);
  // Fehler dürfen den Worker nicht killen; bei Fehlschlag bleibt last_scrape_date leer → Retry beim nächsten Tick.
  const r = await runPipeline(
    { branche, stadt, maxResults: cfg.scrapePerDay },
    { maxResults: cfg.scrapePerDay, skipAi: true }
  );
  stateSet('rotation_cursor', String(cursor + 1));
  stateSet('last_scrape_date', todayLocal());
  console.log(`[daily-engine] Scrape fertig: ${r.inserted} neu, ${r.updated} aktualisiert`);
}

async function tick(cfg: EngineConfig): Promise<void> {
  ensureSendJob(cfg);
  ensureFollowupInitialized();
  try {
    await dailyScrape(cfg);
  } catch (err) {
    console.error('[daily-engine] Scrape-Fehler (Retry nächster Tick):', err instanceof Error ? err.message : err);
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
let busy = false;

export function startDailyEngine(): void {
  if (timer) return;
  if (!isEnabled()) {
    console.log('[daily-engine] deaktiviert – zum Aktivieren DAILY_ENGINE=on setzen');
    return;
  }
  ensureStateTable();
  const cfg = loadConfig();
  console.log(`[daily-engine] aktiv | Scrape ${cfg.scrapePerDay}/Tag (${cfg.scrapeVerticals.join(',')}) | Versand-Deckel ${cfg.emailDailyLimit}/Tag`);

  const run = async () => {
    if (busy) return;
    busy = true;
    try { await tick(cfg); } finally { busy = false; }
  };
  run().catch(err => console.error('[daily-engine] Start-Fehler:', err));
  timer = setInterval(run, CHECK_MS);
}
