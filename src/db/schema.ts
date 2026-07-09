import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { buildIdentity } from '../utils/identity';
import { Lead } from '../types';

export function resolveDbPath(
  env: { SQLITE_DB_PATH?: string; RAILWAY_VOLUME_MOUNT_PATH?: string; DATA_DIR?: string } = process.env
): string {
  if (env.SQLITE_DB_PATH?.trim()) {
    return path.resolve(env.SQLITE_DB_PATH.trim());
  }
  const dataDir = env.RAILWAY_VOLUME_MOUNT_PATH?.trim() || env.DATA_DIR?.trim() || path.join(process.cwd(), 'data');
  return path.resolve(dataDir, 'leads.db');
}

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    const dbPath = resolveDbPath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema(db);
  }
  return db;
}

function initSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS leads (
      id                    TEXT PRIMARY KEY,
      created_at            TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at            TEXT NOT NULL DEFAULT (datetime('now')),

      name                  TEXT NOT NULL,
      branche               TEXT NOT NULL,
      stadt                 TEXT NOT NULL,
      stadtbezirk           TEXT,

      adresse               TEXT,
      telefon               TEXT,
      website               TEXT,
      email                 TEXT,
      whatsapp              TEXT,
      kontaktformular_url   TEXT,
      instagram_url         TEXT,
      facebook_url          TEXT,
      tiktok_url            TEXT,
      linkedin_url          TEXT,
      youtube_url           TEXT,

      source_url            TEXT,
      maps_place_id         TEXT UNIQUE,
      normalized_name       TEXT,
      website_domain        TEXT,
      phone_normalized      TEXT,
      email_normalized      TEXT,
      address_key           TEXT,
      duplicate_of          TEXT,
      duplicate_reason      TEXT,

      google_bewertung      REAL,
      google_anzahl_reviews INTEGER,
      google_oeffnungszeiten TEXT,
      google_foto_url       TEXT,

      hat_website           INTEGER NOT NULL DEFAULT 0,
      website_alt           INTEGER,
      hat_chatbot           INTEGER DEFAULT 0,
      hat_whatsapp_link     INTEGER DEFAULT 0,
      hat_online_buchung    INTEGER DEFAULT 0,
      hat_faq               INTEGER DEFAULT 0,
      hat_notdienst_hinweis INTEGER DEFAULT 0,
      website_meta          TEXT,
      kontaktformular_typ   TEXT,
      kontaktformular_confidence INTEGER,
      website_quality_flags TEXT,

      score_chatbot         INTEGER DEFAULT 0,
      score_telefon         INTEGER DEFAULT 0,
      score_website         INTEGER DEFAULT 0,
      score_gesamt          INTEGER DEFAULT 0,
      prioritaet            TEXT DEFAULT 'C',
      score_gruende         TEXT,
      website_evidence      TEXT,
      telefonstrategie_empfohlen INTEGER DEFAULT 0,
      bester_kanal          TEXT,
      kontakt_hinweis       TEXT,

      nachricht_chatbot     TEXT,
      nachricht_telefon     TEXT,
      nachricht_website     TEXT,
      ai_analysiert         INTEGER DEFAULT 0,

      status                TEXT NOT NULL DEFAULT 'new',
      approved_nachricht    TEXT,
      approved_kanal        TEXT,
      gesendet_at           TEXT,
      checked_at            TEXT,
      draft_created_at      TEXT,
      approved_at           TEXT,
      contacted_at          TEXT,
      last_manual_call_at   TEXT,
      manual_call_note      TEXT,
      manual_call_done      INTEGER DEFAULT 0,
      notiz                 TEXT,

      scrape_error          TEXT,
      analyze_error         TEXT
    );

    CREATE TABLE IF NOT EXISTS scrape_runs (
      id          TEXT PRIMARY KEY,
      started_at  TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      stadt       TEXT NOT NULL,
      branche     TEXT NOT NULL,
      stadtbezirk TEXT,
      leads_found INTEGER DEFAULT 0,
      leads_new   INTEGER DEFAULT 0,
      error       TEXT
    );

    CREATE TABLE IF NOT EXISTS contact_points (
      id          TEXT PRIMARY KEY,
      lead_id     TEXT NOT NULL,
      type        TEXT NOT NULL,
      value       TEXT NOT NULL,
      source_url  TEXT,
      confidence  INTEGER NOT NULL DEFAULT 70,
      verified_at TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
      UNIQUE(type, value)
    );

    CREATE TABLE IF NOT EXISTS outreach_events (
      id          TEXT PRIMARY KEY,
      lead_id     TEXT NOT NULL,
      event_type  TEXT NOT NULL,
      channel     TEXT,
      message     TEXT,
      status      TEXT,
      user        TEXT,
      note        TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_leads_prioritaet ON leads(prioritaet);
    CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
    CREATE INDEX IF NOT EXISTS idx_leads_branche ON leads(branche);
    CREATE INDEX IF NOT EXISTS idx_leads_stadt ON leads(stadt);
    CREATE INDEX IF NOT EXISTS idx_contact_points_lead ON contact_points(lead_id);
    CREATE INDEX IF NOT EXISTS idx_outreach_events_lead ON outreach_events(lead_id);
  `);
  ensureColumns(db, 'leads', {
    score_gruende: 'TEXT',
    website_evidence: 'TEXT',
    telefonstrategie_empfohlen: 'INTEGER DEFAULT 0',
    bester_kanal: 'TEXT',
    kontakt_hinweis: 'TEXT',
    instagram_url: 'TEXT',
    facebook_url: 'TEXT',
    tiktok_url: 'TEXT',
    linkedin_url: 'TEXT',
    youtube_url: 'TEXT',
    kontaktformular_typ: 'TEXT',
    kontaktformular_confidence: 'INTEGER',
    website_quality_flags: 'TEXT',
    normalized_name: 'TEXT',
    website_domain: 'TEXT',
    phone_normalized: 'TEXT',
    email_normalized: 'TEXT',
    address_key: 'TEXT',
    duplicate_of: 'TEXT',
    duplicate_reason: 'TEXT',
    checked_at: 'TEXT',
    draft_created_at: 'TEXT',
    approved_at: 'TEXT',
    contacted_at: 'TEXT',
    last_manual_call_at: 'TEXT',
    manual_call_note: 'TEXT',
    manual_call_done: 'INTEGER DEFAULT 0',
  });
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_leads_domain ON leads(website_domain);
    CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone_normalized);
    CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email_normalized);
    CREATE INDEX IF NOT EXISTS idx_leads_identity ON leads(normalized_name, address_key);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_templates (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL DEFAULT 'Standard',
      subject    TEXT NOT NULL DEFAULT '',
      body       TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS send_jobs (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      vertical_id   TEXT,
      branche_terms TEXT,
      template_ids  TEXT NOT NULL DEFAULT '[]',
      total_target  INTEGER NOT NULL,
      daily_limit   INTEGER NOT NULL DEFAULT 100,
      min_gap_s     INTEGER NOT NULL DEFAULT 60,
      max_gap_s     INTEGER NOT NULL DEFAULT 180,
      window_start  INTEGER NOT NULL DEFAULT 8,
      window_end    INTEGER NOT NULL DEFAULT 20,
      sent_count    INTEGER NOT NULL DEFAULT 0,
      failed_count  INTEGER NOT NULL DEFAULT 0,
      status        TEXT NOT NULL DEFAULT 'running',
      note          TEXT,
      next_send_at  TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at   TEXT
    );

    CREATE TABLE IF NOT EXISTS sent_emails (
      id          TEXT PRIMARY KEY,
      job_id      TEXT,
      lead_id     TEXT,
      to_email    TEXT NOT NULL,
      to_name     TEXT,
      subject     TEXT,
      body        TEXT,
      template_id TEXT,
      success     INTEGER NOT NULL DEFAULT 1,
      error       TEXT,
      message_id  TEXT,
      sent_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sent_emails_date ON sent_emails(sent_at);
    CREATE INDEX IF NOT EXISTS idx_sent_emails_job ON sent_emails(job_id);

    CREATE TABLE IF NOT EXISTS email_events (
      id            TEXT PRIMARY KEY,
      sent_email_id TEXT NOT NULL,
      event_type    TEXT NOT NULL,
      url           TEXT,
      user_agent    TEXT,
      ip            TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_email_events_sent ON email_events(sent_email_id);
    CREATE INDEX IF NOT EXISTS idx_email_events_type ON email_events(event_type);

    CREATE TABLE IF NOT EXISTS web_visits (
      id            TEXT PRIMARY KEY,
      visitor_id    TEXT NOT NULL,
      channel       TEXT NOT NULL DEFAULT 'web',
      source        TEXT,
      medium        TEXT,
      campaign      TEXT,
      sent_email_id TEXT,
      lead_id       TEXT,
      url           TEXT NOT NULL,
      path          TEXT,
      title         TEXT,
      referrer      TEXT,
      user_agent    TEXT,
      ip            TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_web_visits_visitor ON web_visits(visitor_id);
    CREATE INDEX IF NOT EXISTS idx_web_visits_channel ON web_visits(channel);
    CREATE INDEX IF NOT EXISTS idx_web_visits_created ON web_visits(created_at);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS idea_campaigns (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      idea         TEXT NOT NULL,
      landing_page TEXT,
      platforms    TEXT DEFAULT '["instagram_facebook"]',
      duration_days INTEGER DEFAULT 7,
      status       TEXT DEFAULT 'active',
      variants     TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      ends_at      TEXT
    );

    CREATE TABLE IF NOT EXISTS campaign_results (
      id            TEXT PRIMARY KEY,
      campaign_id   TEXT NOT NULL,
      variant_index INTEGER DEFAULT 0,
      platform      TEXT,
      impressions   INTEGER DEFAULT 0,
      clicks        INTEGER DEFAULT 0,
      signups       INTEGER DEFAULT 0,
      spend_eur     REAL DEFAULT 0,
      note          TEXT,
      logged_at     TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (campaign_id) REFERENCES idea_campaigns(id) ON DELETE CASCADE
    );
  `);
  migrateStatuses(db);
  backfillLeadIdentity(db);
  backfillContactPoints(db);
  backfillOutreachEvents(db);
}

function ensureColumns(db: Database.Database, table: string, columns: Record<string, string>) {
  const existing = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(col => col.name)
  );
  for (const [name, definition] of Object.entries(columns)) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  }
}

function migrateStatuses(db: Database.Database) {
  const mappings: Record<string, string> = {
    neu: 'new',
    analysiert: 'checked',
    bereit: 'draft_ready',
    gesendet: 'contacted',
    abgelehnt: 'not_suitable',
    nicht_erreichbar: 'manual_review',
  };

  const update = db.prepare('UPDATE leads SET status = ?, updated_at = datetime(\'now\') WHERE status = ?');
  for (const [oldStatus, newStatus] of Object.entries(mappings)) {
    update.run(newStatus, oldStatus);
  }
}

function backfillLeadIdentity(db: Database.Database) {
  const rows = db.prepare(
    `SELECT id, name, website, telefon, email, adresse, stadt
     FROM leads
     WHERE normalized_name IS NULL
        OR website_domain IS NULL
        OR phone_normalized IS NULL
        OR email_normalized IS NULL
        OR address_key IS NULL`
  ).all() as Lead[];

  const update = db.prepare(
    `UPDATE leads
     SET normalized_name = COALESCE(normalized_name, @normalized_name),
         website_domain = COALESCE(website_domain, @website_domain),
         phone_normalized = COALESCE(phone_normalized, @phone_normalized),
         email_normalized = COALESCE(email_normalized, @email_normalized),
         address_key = COALESCE(address_key, @address_key)
     WHERE id = @id`
  );

  for (const row of rows) {
    const identity = buildIdentity(row);
    update.run({
      id: row.id,
      normalized_name: identity.normalized_name ?? null,
      website_domain: identity.website_domain ?? null,
      phone_normalized: identity.phone_normalized ?? null,
      email_normalized: identity.email_normalized ?? null,
      address_key: identity.address_key ?? null,
    });
  }
}

function backfillContactPoints(db: Database.Database) {
  const existingCount = (db.prepare('SELECT COUNT(*) as n FROM contact_points').get() as { n: number }).n;
  const leadCount = (db.prepare('SELECT COUNT(*) as n FROM leads').get() as { n: number }).n;
  if (leadCount === 0 || existingCount >= leadCount) return;

  const rows = db.prepare(
    `SELECT l.id, l.email, l.whatsapp, l.telefon, l.kontaktformular_url, l.website, l.source_url,
            l.instagram_url, l.facebook_url, l.tiktok_url, l.linkedin_url, l.youtube_url
     FROM leads l
     WHERE NOT EXISTS (SELECT 1 FROM contact_points cp WHERE cp.lead_id = l.id)
     LIMIT 1000`
  ).all() as Lead[];

  const insert = db.prepare(
    `INSERT OR IGNORE INTO contact_points (id, lead_id, type, value, source_url, confidence, verified_at)
     VALUES (lower(hex(randomblob(16))), @lead_id, @type, @value, @source_url, @confidence, datetime('now'))`
  );

  for (const lead of rows) {
    const points = [
      { type: 'email', value: lead.email, source_url: lead.website || lead.source_url, confidence: 90 },
      { type: 'whatsapp', value: lead.whatsapp, source_url: lead.website || lead.source_url, confidence: 85 },
      { type: 'telefon', value: lead.telefon, source_url: lead.source_url, confidence: 80 },
      { type: 'kontaktformular', value: lead.kontaktformular_url, source_url: lead.website || lead.source_url, confidence: lead.kontaktformular_confidence ?? 75 },
      { type: 'instagram', value: lead.instagram_url, source_url: lead.website || lead.source_url, confidence: 80 },
      { type: 'facebook', value: lead.facebook_url, source_url: lead.website || lead.source_url, confidence: 80 },
      { type: 'tiktok', value: lead.tiktok_url, source_url: lead.website || lead.source_url, confidence: 80 },
      { type: 'linkedin', value: lead.linkedin_url, source_url: lead.website || lead.source_url, confidence: 80 },
      { type: 'youtube', value: lead.youtube_url, source_url: lead.website || lead.source_url, confidence: 80 },
      { type: 'website', value: lead.website, source_url: lead.source_url, confidence: 90 },
      { type: 'source', value: lead.source_url, source_url: lead.source_url, confidence: 70 },
    ];

    for (const point of points) {
      if (!point.value) continue;
      insert.run({
        lead_id: lead.id,
        type: point.type,
        value: point.value,
        source_url: point.source_url ?? null,
        confidence: point.confidence,
      });
    }
  }
}

function backfillOutreachEvents(db: Database.Database) {
  const existingCount = (db.prepare('SELECT COUNT(*) as n FROM outreach_events').get() as { n: number }).n;
  if (existingCount > 0) return;

  const rows = db.prepare(
    `SELECT id, status, approved_kanal, approved_nachricht, gesendet_at, approved_at
     FROM leads
     WHERE status IN ('approved', 'contacted')`
  ).all() as Lead[];
  const exists = db.prepare('SELECT COUNT(*) as n FROM outreach_events WHERE lead_id = ? AND event_type = ?');
  const insert = db.prepare(
    `INSERT INTO outreach_events (id, lead_id, event_type, channel, message, status, user, note, created_at)
     VALUES (lower(hex(randomblob(16))), @lead_id, @event_type, @channel, @message, @status, 'migration', @note, COALESCE(@created_at, datetime('now')))`
  );

  for (const lead of rows) {
    if (lead.status === 'approved' && (exists.get(lead.id, 'approved') as { n: number }).n === 0) {
      insert.run({
        lead_id: lead.id,
        event_type: 'approved',
        channel: lead.approved_kanal ?? null,
        message: lead.approved_nachricht ?? null,
        status: 'approved',
        note: 'Aus bestehendem Lead-Status rekonstruiert',
        created_at: lead.approved_at ?? null,
      });
    }
    if (lead.status === 'contacted' && (exists.get(lead.id, 'sent_marked') as { n: number }).n === 0) {
      insert.run({
        lead_id: lead.id,
        event_type: 'sent_marked',
        channel: lead.approved_kanal ?? null,
        message: lead.approved_nachricht ?? null,
        status: 'contacted',
        note: 'Aus bestehendem Lead-Status rekonstruiert; kein echter Versand belegt',
        created_at: lead.gesendet_at ?? null,
      });
    }
  }
}
