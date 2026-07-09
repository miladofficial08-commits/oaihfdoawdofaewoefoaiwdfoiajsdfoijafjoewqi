import { getDb } from './schema';
import { ContactPoint, Lead, LeadStatus, OutreachEvent } from '../types';
import { v4 as uuid } from 'uuid';
import { getVerticalByLabel } from '../config/markets';
import { buildIdentity } from '../utils/identity';

export function upsertLead(
  data: Partial<Lead> & { maps_place_id: string; name: string; branche: string; stadt: string }
): { inserted: boolean; lead: Lead } {
  const db = getDb();
  const identity = buildIdentity(data);
  const enriched = { ...data, ...identity };
  const existing = db.prepare('SELECT * FROM leads WHERE maps_place_id = ?').get(data.maps_place_id) as Lead | undefined;

  if (existing) {
    const updated = { ...existing, ...enriched, updated_at: new Date().toISOString() };
    const cols = Object.keys(updated)
      .filter(k => k !== 'id' && k !== 'created_at')
      .map(k => `${k} = @${k}`)
      .join(', ');
    db.prepare(`UPDATE leads SET ${cols} WHERE id = @id`).run(updated);
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(existing.id) as Lead;
    syncContactPoints(lead);
    return { inserted: false, lead };
  }

  const duplicate = findDuplicateCandidate(enriched);
  const duplicateFields = duplicate ? {
    status: 'duplicate' as LeadStatus,
    duplicate_of: duplicate.lead.id,
    duplicate_reason: duplicate.reason,
  } : {};

  const lead: Lead = {
    id: uuid(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    status: 'new',
    prioritaet: 'C',
    score_gesamt: 0,
    hat_website: 0,
    ...enriched,
    ...duplicateFields,
  } as Lead;

  const keys = Object.keys(lead);
  db.prepare(`INSERT INTO leads (${keys.join(', ')}) VALUES (${keys.map(k => '@' + k).join(', ')})`).run(lead);
  syncContactPoints(lead);
  return { inserted: true, lead };
}

export function findDuplicateCandidate(data: Partial<Lead>): { lead: Lead; reason: string } | undefined {
  const db = getDb();
  const checks: Array<[string, string | undefined, string]> = [
    ['website_domain', data.website_domain, 'Gleiche Website-Domain'],
    ['phone_normalized', data.phone_normalized, 'Gleiche Telefonnummer'],
    ['email_normalized', data.email_normalized, 'Gleiche E-Mail'],
  ];

  for (const [field, value, reason] of checks) {
    if (!value) continue;
    const lead = db.prepare(`SELECT * FROM leads WHERE ${field} = ? AND status != 'duplicate' LIMIT 1`).get(value) as Lead | undefined;
    if (lead) return { lead, reason };
  }

  if (data.normalized_name && data.address_key) {
    const lead = db.prepare(
      `SELECT * FROM leads
       WHERE normalized_name = ? AND address_key = ? AND status != 'duplicate'
       LIMIT 1`
    ).get(data.normalized_name, data.address_key) as Lead | undefined;
    if (lead) return { lead, reason: 'Gleicher Firmenname und gleiche Adresse' };
  }

  return undefined;
}

export function getLeadsByPrioritaet(p: 'A' | 'B' | 'C'): Lead[] {
  return getDb()
    .prepare('SELECT * FROM leads WHERE prioritaet = ? ORDER BY score_gesamt DESC')
    .all(p) as Lead[];
}

export function getLeadsPendingApproval(): Lead[] {
  return getDb()
    .prepare(
      `SELECT * FROM leads
       WHERE status = 'draft_ready'
         AND (nachricht_chatbot IS NOT NULL OR nachricht_telefon IS NOT NULL OR nachricht_website IS NOT NULL)
       ORDER BY score_gesamt DESC`
    )
    .all() as Lead[];
}

export function updateLeadStatus(id: string, status: LeadStatus, extra: Partial<Lead> = {}) {
  const now = new Date().toISOString();
  const timestamps: Partial<Lead> = {};
  if (status === 'checked') timestamps.checked_at = now;
  if (status === 'draft_ready') timestamps.draft_created_at = now;
  if (status === 'approved') timestamps.approved_at = now;
  if (status === 'contacted') timestamps.contacted_at = now;

  const updates = { ...extra, ...timestamps, status, updated_at: now, id };
  const cols = Object.keys(updates)
    .filter(k => k !== 'id')
    .map(k => `${k} = @${k}`)
    .join(', ');
  getDb().prepare(`UPDATE leads SET ${cols} WHERE id = @id`).run(updates);
  recordOutreachEvent({
    lead_id: id,
    event_type: 'status_changed',
    status,
    note: extra.notiz,
  });
}

export function markSent(id: string, kanal: string, nachricht: string) {
  recordManualContact(id, kanal, nachricht);
}

export function recordManualContact(id: string, kanal: string, nachricht: string, user = 'local-user') {
  updateLeadStatus(id, 'contacted', {
    approved_kanal: kanal,
    approved_nachricht: nachricht,
    gesendet_at: new Date().toISOString(),
  });
  recordOutreachEvent({
    lead_id: id,
    event_type: 'manual_contact',
    channel: kanal,
    message: nachricht,
    status: 'contacted',
    user,
    note: `Manuell per ${kanal} kontaktiert markiert. Kein echter Versand wurde ausgefuehrt.`,
  });
}

export function recordEmailSent(id: string, messageId?: string, user = 'local-user') {
  updateLeadStatus(id, 'contacted', {
    approved_kanal: 'email',
    gesendet_at: new Date().toISOString(),
  });
  recordOutreachEvent({
    lead_id: id,
    event_type: 'email_sent',
    channel: 'email',
    status: 'contacted',
    user,
    note: messageId ? `SMTP-Versand bestaetigt: ${messageId}` : 'SMTP-Versand bestaetigt.',
  });
}

export function recordApproval(id: string, kanal: string, nachricht: string, user = 'local-user') {
  updateLeadStatus(id, 'approved', {
    approved_kanal: kanal,
    approved_nachricht: nachricht,
  });
  recordOutreachEvent({
    lead_id: id,
    event_type: 'approved',
    channel: kanal,
    message: nachricht,
    status: 'approved',
    user,
  });
}

export function recordManualCall(id: string, note: string, user = 'local-user') {
  const now = new Date().toISOString();
  updateLeadStatus(id, 'manual_review', {
    last_manual_call_at: now,
    manual_call_note: note,
    manual_call_done: 1,
    notiz: note,
  });
  recordOutreachEvent({
    lead_id: id,
    event_type: 'manual_call',
    channel: 'telefon',
    status: 'manual_review',
    user,
    note,
  });
}

export function archiveLead(id: string, user = 'local-user') {
  updateLeadStatus(id, 'archived');
  recordOutreachEvent({
    lead_id: id,
    event_type: 'archived',
    status: 'archived',
    user,
    note: 'Lead archiviert. Daten, Kontaktpunkte, Notizen und Historie bleiben erhalten.',
  });
}

export function deleteLeadPermanently(id: string, opts: { confirmContacted?: boolean } = {}) {
  const db = getDb();
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(id) as Lead | undefined;
  if (!lead) return { deleted: false };
  const contactEvent = db.prepare(
    `SELECT 1 FROM outreach_events
     WHERE lead_id = ?
       AND event_type IN ('manual_contact', 'sent_marked')
     LIMIT 1`
  ).get(id);
  const wasContacted = ['contacted', 'replied', 'demo_booked', 'proposal_sent', 'won'].includes(lead.status)
    || Boolean(lead.contacted_at)
    || Boolean(lead.gesendet_at)
    || Boolean(contactEvent);
  if (wasContacted && !opts.confirmContacted) {
    throw new Error('Endgueltiges Loeschen kontaktierte Leads braucht eine extra Bestaetigung.');
  }
  db.transaction(() => {
    db.prepare('DELETE FROM contact_points WHERE lead_id = ?').run(id);
    db.prepare('DELETE FROM outreach_events WHERE lead_id = ?').run(id);
    db.prepare('DELETE FROM leads WHERE id = ?').run(id);
  })();
  return { deleted: true };
}

export function recordOutreachEvent(data: Omit<OutreachEvent, 'id' | 'created_at'>) {
  getDb().prepare(
    `INSERT INTO outreach_events (id, lead_id, event_type, channel, message, status, user, note)
     VALUES (@id, @lead_id, @event_type, @channel, @message, @status, @user, @note)`
  ).run({
    id: uuid(),
    channel: null,
    message: null,
    status: null,
    user: null,
    note: null,
    ...data,
  });
}

export function getContactPoints(leadId: string): ContactPoint[] {
  return getDb()
    .prepare('SELECT * FROM contact_points WHERE lead_id = ? ORDER BY type, confidence DESC')
    .all(leadId) as ContactPoint[];
}

export function getOutreachEvents(leadId: string): OutreachEvent[] {
  return getDb()
    .prepare('SELECT * FROM outreach_events WHERE lead_id = ? ORDER BY created_at DESC')
    .all(leadId) as OutreachEvent[];
}

export function getLeadById(id: string): Lead | undefined {
  return getDb().prepare('SELECT * FROM leads WHERE id = ?').get(id) as Lead | undefined;
}

export function getContactPointsBatch(leadIds: string[]): Record<string, ContactPoint[]> {
  if (!leadIds.length) return {};
  const placeholders = leadIds.map(() => '?').join(',');
  const rows = getDb()
    .prepare(`SELECT * FROM contact_points WHERE lead_id IN (${placeholders}) ORDER BY type, confidence DESC`)
    .all(...leadIds) as ContactPoint[];
  const result: Record<string, ContactPoint[]> = {};
  for (const row of rows) {
    if (!result[row.lead_id]) result[row.lead_id] = [];
    result[row.lead_id].push(row);
  }
  return result;
}

export function getOutreachEventsBatch(leadIds: string[]): Record<string, OutreachEvent[]> {
  if (!leadIds.length) return {};
  const placeholders = leadIds.map(() => '?').join(',');
  const rows = getDb()
    .prepare(`SELECT * FROM outreach_events WHERE lead_id IN (${placeholders}) ORDER BY created_at DESC`)
    .all(...leadIds) as OutreachEvent[];
  const result: Record<string, OutreachEvent[]> = {};
  for (const row of rows) {
    if (!result[row.lead_id]) result[row.lead_id] = [];
    result[row.lead_id].push(row);
  }
  return result;
}

export function getAllLeads(
  filter: Partial<{ stadt: string; branche: string; prioritaet: string; status: string; includeArchived: string }> = {}
): Lead[] {
  const conditions: string[] = [];
  const params: Record<string, string> = {};

  if (filter.includeArchived !== '1' && filter.status !== 'archived') {
    conditions.push(`status != 'archived'`);
  }
  if (filter.status) {
    conditions.push(`status = @status`);
    params.status = filter.status;
  }
  if (filter.prioritaet) {
    conditions.push(`prioritaet = @prioritaet`);
    params.prioritaet = filter.prioritaet;
  }
  if (filter.stadt) {
    conditions.push(`stadt LIKE @stadt`);
    params.stadt = `%${filter.stadt}%`;
  }
  if (filter.branche) {
    conditions.push(`branche LIKE @branche`);
    params.branche = `%${filter.branche}%`;
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return getDb()
    .prepare(`SELECT * FROM leads ${where} ORDER BY score_gesamt DESC`)
    .all(params) as Lead[];
}

export function createScrapeRun(stadt: string, branche: string, stadtbezirk?: string): string {
  const id = uuid();
  getDb()
    .prepare(`INSERT INTO scrape_runs (id, stadt, branche, stadtbezirk) VALUES (?, ?, ?, ?)`)
    .run(id, stadt, branche, stadtbezirk ?? null);
  return id;
}

export function finishScrapeRun(id: string, leadsFound: number, leadsNew: number, error?: string) {
  getDb()
    .prepare(`UPDATE scrape_runs SET finished_at = datetime('now'), leads_found = ?, leads_new = ?, error = ? WHERE id = ?`)
    .run(leadsFound, leadsNew, error ?? null, id);
}

export function getDailyReport() {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const leads = db.prepare(`SELECT branche, prioritaet, score_gesamt FROM leads WHERE status != 'archived'`).all() as Lead[];
  const value = estimatePipelineValue(leads);

  return {
    neue: (db.prepare(`SELECT COUNT(*) as n FROM leads WHERE date(created_at) = ?`).get(today) as { n: number }).n,
    a_leads: (db.prepare(`SELECT COUNT(*) as n FROM leads WHERE prioritaet = 'A' AND status != 'archived'`).get() as { n: number }).n,
    b_leads: (db.prepare(`SELECT COUNT(*) as n FROM leads WHERE prioritaet = 'B' AND status != 'archived'`).get() as { n: number }).n,
    gesendet_heute: (db.prepare(`SELECT COUNT(*) as n FROM leads WHERE date(gesendet_at) = ?`).get(today) as { n: number }).n,
    pending_approval: (db.prepare(`SELECT COUNT(*) as n FROM leads WHERE status = 'draft_ready'`).get() as { n: number }).n,
    gesamt: (db.prepare(`SELECT COUNT(*) as n FROM leads WHERE status != 'archived'`).get() as { n: number }).n,
    archived: (db.prepare(`SELECT COUNT(*) as n FROM leads WHERE status = 'archived'`).get() as { n: number }).n,
    status_counts: getStatusCounts(),
    pipeline_value: value.pipelineValue,
    weighted_value: value.weightedValue,
    potential_mrr: value.potentialMrr,
  };
}

export function getStatusCounts(): Record<string, number> {
  const rows = getDb().prepare('SELECT status, COUNT(*) as n FROM leads GROUP BY status').all() as Array<{ status: string; n: number }>;
  return Object.fromEntries(rows.map(row => [row.status, row.n]));
}

function syncContactPoints(lead: Lead) {
  getDb().prepare('DELETE FROM contact_points WHERE lead_id = ?').run(lead.id);
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
  ].filter(point => point.value) as Array<{ type: string; value: string; source_url?: string; confidence: number }>;

  const stmt = getDb().prepare(
    `INSERT INTO contact_points (id, lead_id, type, value, source_url, confidence, verified_at)
     VALUES (@id, @lead_id, @type, @value, @source_url, @confidence, @verified_at)
     ON CONFLICT(type, value) DO UPDATE SET
       lead_id = excluded.lead_id,
       source_url = excluded.source_url,
       confidence = excluded.confidence,
       verified_at = excluded.verified_at`
  );
  const verified_at = new Date().toISOString();
  for (const point of points) {
    stmt.run({
      id: uuid(),
      lead_id: lead.id,
      verified_at,
      type: point.type,
      value: point.value,
      source_url: point.source_url ?? null,
      confidence: point.confidence,
    });
  }
}

export function refreshContactPoints(lead: Lead) {
  syncContactPoints(lead);
}

function estimatePipelineValue(leads: Lead[]) {
  return leads.reduce((sum, lead) => {
    if (lead.prioritaet === 'C') return sum;
    const preset = getVerticalByLabel(lead.branche);
    const deal = preset?.avgDealValue ?? 3000;
    const mrr = preset?.monthlyRetainer ?? 290;
    const closeRate = lead.prioritaet === 'A'
      ? (preset?.closeRate ?? 0.03)
      : (preset?.closeRate ?? 0.03) * 0.45;

    return {
      pipelineValue: sum.pipelineValue + deal,
      weightedValue: sum.weightedValue + Math.round(deal * closeRate),
      potentialMrr: sum.potentialMrr + Math.round(mrr * closeRate),
    };
  }, { pipelineValue: 0, weightedValue: 0, potentialMrr: 0 });
}
