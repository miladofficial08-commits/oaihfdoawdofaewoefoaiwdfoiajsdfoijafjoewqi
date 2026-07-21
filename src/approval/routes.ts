import { FastifyInstance } from 'fastify';
import path from 'path';
import fs from 'fs';
import { createHash } from 'crypto';
import {
  getLeadsPendingApproval,
  updateLeadStatus,
  markSent,
  recordApproval,
  recordManualContact,
  recordManualCall,
  getContactPoints,
  getOutreachEvents,
  getContactPointsBatch,
  getOutreachEventsBatch,
  getAllLeads,
  getDailyReport,
  archiveLead,
  deleteLeadPermanently,
  recordOutreachEvent,
} from '../db/leads-repo';
import { Lead } from '../types';
import { nrwRegions, verticalPresets } from '../config/markets';
import { runPipeline } from '../pipeline';
import { reanalyzeExistingLeads } from '../reanalyze-existing';
import { personalizeLead, getAiProvider } from '../ai/personalizer';
import { exportToCsv } from '../export/csv-export';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { getSmtpStatus, sendLeadEmail, sendBulkEmail, getTrackingBaseUrl, sendTestEmail, sendBrevoTestEmail } from '../email/mailer';
import { getSmsAnalytics } from '../email/sms-stats';
import { generateAdVariants } from '../ai/ad-generator';
import { v4 as uuid } from 'uuid';
import { getDb } from '../db/schema';
import { fetchInboxEmails, getImapStatus, markEmailSeen } from '../email/inbox';
import { getEmailTemplate, updateEmailTemplate, renderTemplate, listEmailTemplates, createEmailTemplate, deleteEmailTemplate, getTemplateById, seedFollowupTemplates } from '../email/template';
import { startAutoSender, recordSentEmail, sentTodayCount, GLOBAL_DAILY_CAP, ALLOWED_DAILY_LIMITS, SendJob } from '../email/auto-sender';
import { startFollowupSender, getFollowupConfig, setFollowupConfig, followupStats } from '../email/followup-sender';
import { classifyOpenEvent, isOpenLikeEvent, isReliableOpen, secondsBetween, countDistinctOpens, OPEN_DEDUP_WINDOW_SECONDS, classifyClickEvent, isRealClick, isClickLikeEvent, countDistinctClicks } from '../email/tracking';
import { classifyEmailDelivery } from '../email/email-status';
import { startScheduledSender } from '../email/scheduled-sender';

const BERLIN_TZ = 'Europe/Berlin';

/** Wandelt eine Berlin-Wanduhrzeit (datetime-local "YYYY-MM-DDTHH:mm") in einen UTC-ISO-Zeitpunkt um. */
function berlinLocalToUtcIso(localStr: string): string | null {
  const m = String(localStr).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return null;
  const [, Y, Mo, D, H, Mi] = m.map(Number);
  const guess = Date.UTC(Y, Mo - 1, D, H, Mi);
  const offsetAt = (utcMs: number): number => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: BERLIN_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(utcMs));
    const g = (t: string) => Number(parts.find(p => p.type === t)?.value || '0');
    const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
    return (asUtc - utcMs) / 60000; // Minuten östlich von UTC
  };
  let utc = guess - offsetAt(guess) * 60000;
  utc = guess - offsetAt(utc) * 60000; // eine Verfeinerung für DST-Ränder
  const d = new Date(utc);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Nimmt einen vom Client gelieferten Planungszeitpunkt entgegen (Berlin-Wanduhr ODER ISO mit Zone). */
function resolveScheduleIso(value: string): string | null {
  const s = String(value || '').trim();
  if (!s) return null;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return berlinLocalToUtcIso(s);
}

function parseDbTime(value: unknown): Date | null {
  if (!value) return null;
  const raw = String(value);
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(raw)
    ? raw.replace(' ', 'T') + 'Z'
    : raw;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function berlinParts(value: unknown): { day: string; hour: number; label: string } | null {
  const date = parseDbTime(value);
  if (!date) return null;
  const parts = new Intl.DateTimeFormat('de-DE', {
    timeZone: BERLIN_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string) => parts.find(p => p.type === type)?.value || '';
  return {
    day: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')),
    label: `${get('day')}.${get('month')}.${get('year').slice(2)}, ${get('hour')}:${get('minute')}`,
  };
}

function berlinLabel(value: unknown): string | null {
  return berlinParts(value)?.label ?? null;
}

function requestSignature(req: { headers: Record<string, unknown>; ip?: string }): string {
  return createHash('sha256')
    .update(String(req.headers['user-agent'] || ''))
    .update('|')
    .update(req.ip || '')
    .digest('hex')
    .slice(0, 24);
}

export async function registerRoutes(app: FastifyInstance) {
  function sendDashboardHtml(reply: { type: (contentType: string) => { send: (body: string) => unknown } }) {
    const srcPath = path.join(process.cwd(), 'src', 'approval', 'views', 'dashboard.html');
    const distPath = path.join(__dirname, 'views', 'dashboard.html');
    const html = fs.readFileSync(fs.existsSync(srcPath) ? srcPath : distPath, 'utf-8');
    return reply.type('text/html').send(html);
  }

  // Dashboard UI
  app.get('/', async (_req, reply) => {
    return sendDashboardHtml(reply);
  });

  app.get('/dashboard', async (_req, reply) => sendDashboardHtml(reply));
  app.get('/analyse', async (_req, reply) => sendDashboardHtml(reply));

  app.get('/api/pending', async () => enrichLeads(getLeadsPendingApproval()));

  app.get<{ Querystring: { stadt?: string; branche?: string; prioritaet?: string; status?: string; includeArchived?: string } }>(
    '/api/leads',
    async (req) => enrichLeads(getAllLeads(req.query))
  );

  app.get('/api/report', async () => getDailyReport());

  app.get<{ Querystring: { stadt?: string; branche?: string; prioritaet?: string; status?: string; includeArchived?: string } }>(
    '/api/export',
    async (req, reply) => {
      const file = exportToCsv(req.query);
      const filename = path.basename(file);
      reply
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .type('text/csv; charset=utf-8')
        .send(fs.readFileSync(file));
    }
  );

  app.get('/api/strategy', async () => ({
    verticals: verticalPresets,
    regions: nrwRegions,
    gaps: [
      'OpenAI API-Key eintragen und AI-Provider auf openai lassen',
      'Mindestens 4 NRW-Kampagnen pro Woche mit 25-100 Leads je Vertikal laufen lassen',
      'Antworten, Termine und Deals als Status im System nachpflegen',
      'Optional: Google Sheet/Supabase Sync und n8n Follow-up-Sequenzen anbinden',
    ],
  }));

  app.post<{ Body: { branche: string; stadt?: string; staedte?: string[]; bezirk?: string; max?: number; skipAi?: boolean } }>(
    '/api/run',
    async (req, reply) => {
      const { branche, stadt, staedte, bezirk, skipAi = true } = req.body;
      const max = Math.max(1, Math.min(200, Number(req.body.max) || 25));
      // Ziel-Staedte: explizite Liste (Multi-Stadt) oder eine einzelne Stadt.
      const cities = (Array.isArray(staedte) && staedte.length ? staedte : (stadt ? [stadt] : []))
        .map(s => String(s).trim()).filter(Boolean);
      if (!branche || !cities.length) return reply.status(400).send({ error: 'branche und mindestens eine Stadt sind Pflicht' });

      // Aggregiert ueber alle Staedte; einzelne Stadt-Fehler brechen den Lauf nicht ab.
      const agg = { total: 0, inserted: 0, updated: 0, aiProcessed: 0, errors: 0, duration: 0 };
      const perCity: Array<{ stadt: string; total: number; inserted: number; error?: string }> = [];
      for (const city of cities) {
        try {
          const r = await runPipeline({ branche, stadt: city, stadtbezirk: cities.length === 1 ? bezirk : undefined, maxResults: max }, { maxResults: max, skipAi });
          agg.total += r.total; agg.inserted += r.inserted; agg.updated += r.updated;
          agg.aiProcessed += r.aiProcessed; agg.errors += r.errors; agg.duration += r.duration;
          perCity.push({ stadt: city, total: r.total, inserted: r.inserted });
        } catch (err) {
          agg.errors++;
          perCity.push({ stadt: city, total: 0, inserted: 0, error: err instanceof Error ? err.message : String(err) });
        }
      }
      return { ...agg, cities: cities.length, perCity };
    }
  );

  // Backfill: bestehende Leads erneut analysieren – holt fehlende E-Mails aus Impressum/Kontakt nach.
  app.post('/api/reanalyze', async () => {
    const result = await reanalyzeExistingLeads();
    return result;
  });

  app.post<{ Body: { id: string; kanal: string; nachricht: string } }>(
    '/api/approve',
    async (req, reply) => {
      const { id, kanal, nachricht } = req.body;
      if (!id || !kanal || !nachricht) return reply.status(400).send({ error: 'Fehlende Felder' });
      recordApproval(id, kanal, nachricht);
      return { ok: true };
    }
  );

  app.post<{ Body: { id: string; notiz?: string } }>(
    '/api/reject',
    async (req) => {
      updateLeadStatus(req.body.id, 'not_suitable', { notiz: req.body.notiz });
      return { ok: true };
    }
  );

  app.post<{ Body: { id: string; status: Lead['status']; notiz?: string } }>(
    '/api/status',
    async (req, reply) => {
      const allowed: Lead['status'][] = [
        'new', 'checked', 'missing_data', 'not_suitable', 'duplicate', 'draft_ready', 'approved',
        'contacted', 'replied', 'demo_booked', 'proposal_sent', 'won', 'lost', 'no_interest',
        'do_not_contact', 'manual_review', 'archived',
      ];
      if (!req.body.id || !allowed.includes(req.body.status)) return reply.status(400).send({ error: 'Ungueltiger Status' });
      updateLeadStatus(req.body.id, req.body.status, { notiz: req.body.notiz });
      return { ok: true };
    }
  );

  app.post<{ Body: { id: string; note: string } }>(
    '/api/manual-call',
    async (req, reply) => {
      if (!req.body.id || !req.body.note?.trim()) return reply.status(400).send({ error: 'Lead und Call-Notiz sind Pflicht' });
      recordManualCall(req.body.id, req.body.note.trim());
      return { ok: true };
    }
  );

  app.get<{ Params: { id: string } }>('/api/leads/:id/contact-points', async (req) => getContactPoints(req.params.id));
  app.get<{ Params: { id: string } }>('/api/leads/:id/history', async (req) => getOutreachEvents(req.params.id));

  app.post<{ Body: { id: string; kanal: string; nachricht: string } }>(
    '/api/sent',
    async (req) => {
      markSent(req.body.id, req.body.kanal, req.body.nachricht);
      return { ok: true };
    }
  );

  app.post<{ Body: { id: string; kanal: string; nachricht: string } }>(
    '/api/manual-contact',
    async (req, reply) => {
      if (!req.body.id || !req.body.kanal || !req.body.nachricht) return reply.status(400).send({ error: 'Lead, Kanal und Nachricht sind Pflicht' });
      recordManualContact(req.body.id, req.body.kanal, req.body.nachricht);
      return { ok: true };
    }
  );

  app.post<{ Body: { id: string } }>(
    '/api/prepare-draft',
    async (req, reply) => {
      const lead = getAllLeads().find(l => l.id === req.body.id);
      if (!lead) return reply.status(404).send({ error: 'Lead nicht gefunden' });
      const msgs = await personalizeLead(lead);
      if (!msgs.chatbot && !msgs.telefon && !msgs.website) {
        return reply.status(400).send({ error: 'Kein passender Nachrichtentyp oder AI-Key fehlt' });
      }
      updateLeadStatus(lead.id, 'draft_ready', {
        nachricht_chatbot: msgs.chatbot,
        nachricht_telefon: msgs.telefon,
        nachricht_website: msgs.website,
        ai_analysiert: 1,
      });
      return { ok: true, messages: msgs };
    }
  );

  app.post<{ Body: { id: string; type: 'chatbot' | 'telefon' | 'website'; nachricht: string } }>(
    '/api/edit-message',
    async (req) => {
      const { id, type, nachricht } = req.body;
      const field = `nachricht_${type}` as keyof Lead;
      updateLeadStatus(id, 'draft_ready', { [field]: nachricht } as Partial<Lead>);
      return { ok: true };
    }
  );

  app.post<{ Body: { id: string } }>(
    '/api/archive',
    async (req, reply) => {
      if (!req.body.id) return reply.status(400).send({ error: 'Lead fehlt' });
      archiveLead(req.body.id);
      return { ok: true };
    }
  );

  app.delete<{ Body: { id: string; confirmContacted?: boolean } }>(
    '/api/leads',
    async (req, reply) => {
      if (!req.body.id) return reply.status(400).send({ error: 'Lead fehlt' });
      try {
        return deleteLeadPermanently(req.body.id, { confirmContacted: Boolean(req.body.confirmContacted) });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Lead konnte nicht geloescht werden';
        return reply.status(409).send({ error: message, requiresExtraConfirmation: true });
      }
    }
  );

  // ── Idea Campaigns ────────────────────────────────────────────────────────
  app.get('/api/idea-campaigns', async () => {
    const db = getDb();
    const campaigns = db.prepare('SELECT * FROM idea_campaigns ORDER BY created_at DESC').all() as any[];
    return campaigns.map(c => {
      const results = db.prepare('SELECT * FROM campaign_results WHERE campaign_id = ? ORDER BY logged_at DESC').all(c.id);
      return {
        ...c,
        platforms: JSON.parse(c.platforms || '[]'),
        variants: c.variants ? JSON.parse(c.variants) : [],
        results,
      };
    });
  });

  // Alias for compatibility with older clients expecting /api/campaigns
  app.get('/api/campaigns', async () => {
    const db = getDb();
    const campaigns = db.prepare('SELECT * FROM idea_campaigns ORDER BY created_at DESC').all() as any[];
    return campaigns.map(c => {
      const results = db.prepare('SELECT * FROM campaign_results WHERE campaign_id = ? ORDER BY logged_at DESC').all(c.id);
      return {
        ...c,
        platforms: JSON.parse(c.platforms || '[]'),
        variants: c.variants ? JSON.parse(c.variants) : [],
        results,
      };
    });
  });

  app.post<{ Body: { name: string; idea: string; landingPage?: string; platforms: string[]; durationDays?: number } }>(
    '/api/idea-campaigns',
    async (req, reply) => {
      const { name, idea, landingPage, platforms = ['instagram_facebook'], durationDays = 7 } = req.body;
      if (!name || !idea) return reply.status(400).send({ error: 'Name und Idee sind Pflicht' });

      const variants = await generateAdVariants({ idea, landingPage, platforms });
      const id = uuid();
      const endsAt = new Date(Date.now() + durationDays * 86400000).toISOString();

      getDb().prepare(
        `INSERT INTO idea_campaigns (id, name, idea, landing_page, platforms, duration_days, status, variants, ends_at)
         VALUES (@id, @name, @idea, @landing_page, @platforms, @duration_days, 'active', @variants, @ends_at)`
      ).run({
        id, name, idea,
        landing_page: landingPage ?? null,
        platforms: JSON.stringify(platforms),
        duration_days: durationDays,
        variants: JSON.stringify(variants),
        ends_at: endsAt,
      });

      return { id, name, variants, ends_at: endsAt };
    }
  );

  app.post<{ Body: { name: string; idea: string; landingPage?: string; platforms: string[]; durationDays?: number } }>(
    '/api/campaigns',
    async (req, reply) => {
      const { name, idea, landingPage, platforms = ['instagram_facebook'], durationDays = 7 } = req.body;
      if (!name || !idea) return reply.status(400).send({ error: 'Name und Idee sind Pflicht' });

      const variants = await generateAdVariants({ idea, landingPage, platforms });
      const id = uuid();
      const endsAt = new Date(Date.now() + durationDays * 86400000).toISOString();

      getDb().prepare(
        `INSERT INTO idea_campaigns (id, name, idea, landing_page, platforms, duration_days, status, variants, ends_at)
         VALUES (@id, @name, @idea, @landing_page, @platforms, @duration_days, 'active', @variants, @ends_at)`
      ).run({
        id, name, idea,
        landing_page: landingPage ?? null,
        platforms: JSON.stringify(platforms),
        duration_days: durationDays,
        variants: JSON.stringify(variants),
        ends_at: endsAt,
      });

      return { id, name, variants, ends_at: endsAt };
    }
  );

  app.post<{ Params: { id: string }; Body: { variant_index: number; platform: string; impressions: number; clicks: number; signups: number; spend_eur: number; note?: string } }>(
    '/api/idea-campaigns/:id/results',
    async (req, reply) => {
      const { variant_index, platform, impressions, clicks, signups, spend_eur, note } = req.body;
      const resultId = uuid();
      getDb().prepare(
        `INSERT INTO campaign_results (id, campaign_id, variant_index, platform, impressions, clicks, signups, spend_eur, note)
         VALUES (@id, @campaign_id, @variant_index, @platform, @impressions, @clicks, @signups, @spend_eur, @note)`
      ).run({ id: resultId, campaign_id: req.params.id, variant_index, platform, impressions, clicks, signups, spend_eur, note: note ?? null });
      return { ok: true };
    }
  );

  app.post<{ Params: { id: string }; Body: { variant_index: number; platform: string; impressions: number; clicks: number; signups: number; spend_eur: number; note?: string } }>(
    '/api/campaigns/:id/results',
    async (req, reply) => {
      const { variant_index, platform, impressions, clicks, signups, spend_eur, note } = req.body;
      const resultId = uuid();
      getDb().prepare(
        `INSERT INTO campaign_results (id, campaign_id, variant_index, platform, impressions, clicks, signups, spend_eur, note)
         VALUES (@id, @campaign_id, @variant_index, @platform, @impressions, @clicks, @signups, @spend_eur, @note)`
      ).run({ id: resultId, campaign_id: req.params.id, variant_index, platform, impressions, clicks, signups, spend_eur, note: note ?? null });
      return { ok: true };
    }
  );

  app.patch<{ Params: { id: string }; Body: { status: string } }>(
    '/api/idea-campaigns/:id/status',
    async (req, reply) => {
      const allowed = ['active', 'paused', 'won', 'stopped'];
      if (!allowed.includes(req.body.status)) return reply.status(400).send({ error: 'Ungültiger Status' });
      getDb().prepare('UPDATE idea_campaigns SET status = ? WHERE id = ?').run(req.body.status, req.params.id);
      return { ok: true };
    }
  );

  app.patch<{ Params: { id: string }; Body: { status: string } }>(
    '/api/campaigns/:id/status',
    async (req, reply) => {
      const allowed = ['active', 'paused', 'won', 'stopped'];
      if (!allowed.includes(req.body.status)) return reply.status(400).send({ error: 'Ungültiger Status' });
      getDb().prepare('UPDATE idea_campaigns SET status = ? WHERE id = ?').run(req.body.status, req.params.id);
      return { ok: true };
    }
  );

  app.delete<{ Params: { id: string } }>(
    '/api/idea-campaigns/:id',
    async (req) => {
      getDb().prepare('DELETE FROM idea_campaigns WHERE id = ?').run(req.params.id);
      return { ok: true };
    }
  );

  app.delete<{ Params: { id: string } }>(
    '/api/campaigns/:id',
    async (req) => {
      getDb().prepare('DELETE FROM idea_campaigns WHERE id = ?').run(req.params.id);
      return { ok: true };
    }
  );

  // ── Landing Page Analyzer ─────────────────────────────────────────────────
  app.post<{ Body: { url: string } }>(
    '/api/analyze-landing-page',
    async (req, reply) => {
      const { url } = req.body;
      if (!url) return reply.status(400).send({ error: 'URL fehlt' });

      let pageText = '';
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Mozilla/5.0' } });
        const html = await res.text();
        pageText = html
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 4000);
      } catch {
        return reply.status(400).send({ error: 'Landing Page konnte nicht geladen werden' });
      }

      const prompt = `Analysiere diese Landing Page und schreibe eine präzise Produkt-Beschreibung für einen Ideen-Validator.

LANDING PAGE INHALT:
${pageText}

AUFGABE:
Schreibe 3-5 Sätze die folgendes beschreiben:
- Was ist das Produkt / die Dienstleistung?
- Für wen ist es (Zielgruppe)?
- Welches konkrete Problem löst es?
- Was ist der Hauptnutzen / das Ergebnis für den Nutzer?

Schreibe direkt und konkret. Kein Fachjargon. Keine Floskeln. Nur der Inhalt, kein Kommentar davor oder danach.`;

      const provider = getAiProvider();
      let description = '';

      if (provider === 'openai') {
        const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const res = await client.chat.completions.create({
          model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 300,
          temperature: 0.4,
        });
        description = res.choices[0]?.message?.content ?? '';
      } else {
        const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const msg = await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 300,
          messages: [{ role: 'user', content: prompt }],
        });
        const block = msg.content.find(b => b.type === 'text');
        description = block?.type === 'text' ? block.text : '';
      }

      if (!description) return reply.status(500).send({ error: 'KI hat keine Beschreibung generiert' });
      return { description: description.trim() };
    }
  );

  // ── E-Mail ────────────────────────────────────────────────────────────────
  app.get('/api/smtp-status', async () => getSmtpStatus());

  // Live-Test: Verbindung + Auth + echter Testmail-Versand über den aktiven SMTP (Brevo).
  app.post<{ Body: { to?: string } }>('/api/smtp-test', async (req, reply) => {
    const result = await sendTestEmail(req.body?.to);
    if (!result.success) return reply.status(502).send(result);
    return result;
  });

  app.post<{ Body: { to?: string } }>('/api/brevo-test', async (req, reply) => {
    const result = await sendBrevoTestEmail(req.body?.to);
    if (!result.success) return reply.status(502).send(result);
    return result;
  });

  app.post<{ Body: { id: string; to: string; subject: string; body: string } }>(
    '/api/send-email',
    async (req, reply) => {
      const { id, to, subject, body } = req.body;
      if (!id || !to || !subject || !body) {
        return reply.status(400).send({ error: 'id, to, subject und body sind Pflicht' });
      }
      const trackingId = uuid();
      const lead = getAllLeads().find(l => l.id === id);
      const result = await sendLeadEmail({ leadId: id, to, toName: lead?.name, subject, body, trackingId });
      recordSentEmail({ id: trackingId, lead_id: id, to_email: to, to_name: lead?.name, subject, body, success: result.success, error: result.error, message_id: result.messageId });
      if (!result.success) return reply.status(502).send(result);
      return result;
    }
  );

  // ── IMAP Inbox ────────────────────────────────────────────────────────────
  app.get('/api/inbox/status', async () => getImapStatus());

  app.get<{ Querystring: { limit?: string } }>('/api/inbox', async (req) => {
    const limit = Math.min(100, Number(req.query.limit || 40));
    try {
      return await fetchInboxEmails(limit);
    } catch (err) {
      return [];
    }
  });

  app.post<{ Params: { uid: string } }>('/api/inbox/:uid/seen', async (req) => {
    await markEmailSeen(Number(req.params.uid)).catch(() => {});
    return { ok: true };
  });

  // ── Email Templates (mehrere) ─────────────────────────────────────────────
  app.get('/api/email-template', async () => getEmailTemplate());

  app.put<{ Body: { name?: string; subject?: string; body?: string } }>(
    '/api/email-template',
    async (req) => updateEmailTemplate('default', req.body)
  );

  app.get('/api/email-templates', async () => listEmailTemplates());

  app.post<{ Body: { name?: string; subject?: string; body?: string; category?: string } }>(
    '/api/email-templates',
    async (req) => createEmailTemplate({
      name: req.body.name || 'Neue Vorlage',
      subject: req.body.subject || 'Betreff für {name}',
      body: req.body.body || 'Guten Tag {name}-Team,\n\n…\n\nMit freundlichen Grüßen\nTawano',
      category: req.body.category || null,
    })
  );

  app.put<{ Params: { id: string }; Body: { name?: string; subject?: string; body?: string; category?: string } }>(
    '/api/email-templates/:id',
    async (req) => updateEmailTemplate(req.params.id, req.body)
  );

  app.delete<{ Params: { id: string } }>(
    '/api/email-templates/:id',
    async (req, reply) => {
      try { deleteEmailTemplate(req.params.id); return { ok: true }; }
      catch (err) { return reply.status(400).send({ error: err instanceof Error ? err.message : 'Fehler' }); }
    }
  );

  // ── Auto-Versand Jobs ─────────────────────────────────────────────────────
  app.get('/api/send-jobs', async () => {
    const jobs = getDb().prepare('SELECT * FROM send_jobs ORDER BY created_at DESC').all() as SendJob[];
    return jobs.map(j => ({
      ...j,
      template_ids: JSON.parse(j.template_ids || '[]'),
      sent_today: sentTodayCount(j.id),
    }));
  });

  app.get('/api/send-stats', async () => ({
    sent_today_total: sentTodayCount(),
    sent_total: (getDb().prepare('SELECT COUNT(*) as n FROM sent_emails WHERE success = 1').get() as { n: number }).n,
    global_daily_cap: GLOBAL_DAILY_CAP,
    allowed_daily_limits: ALLOWED_DAILY_LIMITS,
  }));

  app.post<{ Body: { name?: string; verticalId?: string; totalTarget: number; dailyLimit?: number; templateIds?: string[]; windowStart?: number; windowEnd?: number; gapSeconds?: number; startAt?: string } }>(
    '/api/send-jobs',
    async (req, reply) => {
      const { name, verticalId, totalTarget, dailyLimit = 100, templateIds = ['default'], windowStart = 8, windowEnd = 24, gapSeconds, startAt } = req.body;
      if (!totalTarget || totalTarget < 1) return reply.status(400).send({ error: 'Anzahl E-Mails fehlt' });
      if (totalTarget > 5000) return reply.status(400).send({ error: 'Maximal 5000 E-Mails pro Job' });
      const safeDaily = ALLOWED_DAILY_LIMITS.includes(dailyLimit) ? dailyLimit : 100;
      // Pause zwischen Mails: min. 15 Sek (Schutz), max. 10 Min. Der Max-Wert bekommt leichte
      // Streuung (×1,5), damit der Versand nicht robotisch-gleichmäßig wirkt (Spam-Schutz).
      const gap = Math.max(15, Math.min(600, Math.round(Number(gapSeconds) || 30)));
      const minGap = gap;
      const maxGap = Math.max(gap + 10, Math.round(gap * 1.5));
      // Startzeit: leer = sofort (datetime('now')). Sonst als lokale Zeit vom Client übernehmen.
      const startProvided = typeof startAt === 'string' && startAt.trim() !== '' && !Number.isNaN(new Date(startAt).getTime());
      const vertical = verticalPresets.find(v => v.id === verticalId);
      const id = uuid();
      getDb().prepare(
        `INSERT INTO send_jobs (id, name, vertical_id, branche_terms, template_ids, total_target, daily_limit, min_gap_s, max_gap_s, window_start, window_end, status, next_send_at)
         VALUES (@id, @name, @vertical_id, @branche_terms, @template_ids, @total_target, @daily_limit, @min_gap_s, @max_gap_s, @window_start, @window_end, 'running', ${startProvided ? '@next_send_at' : "datetime('now')"})`
      ).run({
        id,
        name: name || (vertical ? vertical.label : 'Alle Branchen') + ' – ' + totalTarget + ' E-Mails',
        vertical_id: verticalId ?? null,
        branche_terms: vertical ? JSON.stringify(vertical.searchTerms) : null,
        template_ids: JSON.stringify(templateIds.length ? templateIds : ['default']),
        total_target: totalTarget,
        daily_limit: safeDaily,
        min_gap_s: minGap,
        max_gap_s: maxGap,
        window_start: Math.max(0, Math.min(23, windowStart)),
        window_end: Math.max(1, Math.min(24, windowEnd)),
        ...(startProvided ? { next_send_at: new Date(startAt as string).toISOString() } : {}),
      });
      return { id, ok: true };
    }
  );

  app.patch<{ Params: { id: string }; Body: { status: string } }>(
    '/api/send-jobs/:id',
    async (req, reply) => {
      const allowed = ['running', 'paused', 'stopped'];
      if (!allowed.includes(req.body.status)) return reply.status(400).send({ error: 'Ungültiger Status' });
      const fields = req.body.status === 'stopped'
        ? { status: 'stopped', finished_at: new Date().toISOString(), note: 'Manuell gestoppt' }
        : { status: req.body.status, note: req.body.status === 'paused' ? 'Pausiert' : 'Fortgesetzt' };
      const sets = Object.keys(fields).map(k => `${k} = @${k}`).join(', ');
      getDb().prepare(`UPDATE send_jobs SET ${sets} WHERE id = @id`).run({ ...fields, id: req.params.id });
      return { ok: true };
    }
  );

  app.delete<{ Params: { id: string } }>('/api/send-jobs/:id', async (req) => {
    getDb().prepare('DELETE FROM send_jobs WHERE id = ?').run(req.params.id);
    return { ok: true };
  });

  // ── Gesendete E-Mails (Protokoll) ─────────────────────────────────────────
  app.get<{ Querystring: { limit?: string; job?: string } }>('/api/sent-emails', async (req) => {
    const limit = Math.min(200, Number(req.query.limit || 100));
    const db = getDb();
    return req.query.job
      ? db.prepare('SELECT * FROM sent_emails WHERE job_id = ? ORDER BY sent_at DESC LIMIT ?').all(req.query.job, limit)
      : db.prepare('SELECT * FROM sent_emails ORDER BY sent_at DESC LIMIT ?').all(limit);
  });

  // ── Bulk Send (sofort ODER geplant) + Vorlagen-Auswahl ────────────────────
  app.post<{ Body: { recipients: Array<{ id?: string; name: string; email: string; branche?: string; stadt?: string }>; templateId?: string; scheduleAt?: string; campaign?: string } }>(
    '/api/bulk-send',
    async (req, reply) => {
      const { recipients, templateId, scheduleAt, campaign } = req.body;
      if (!recipients?.length) return reply.status(400).send({ error: 'Empfänger fehlen' });
      const template = (templateId && getTemplateById(templateId)) || getEmailTemplate();

      // Doppel-Mail-Schutz: dieselbe Praxis nie zweimal anschreiben. Adressen ausschließen, die
      // bereits erfolgreich versendet ODER aktuell eingeplant sind – plus Dubletten in dieser Anfrage.
      const alreadyContacted = new Set(
        (getDb().prepare(
          `SELECT LOWER(TRIM(to_email)) e FROM sent_emails WHERE success = 1 AND to_email IS NOT NULL AND to_email != ''
           UNION
           SELECT LOWER(TRIM(to_email)) e FROM scheduled_emails WHERE status IN ('scheduled','processing') AND to_email IS NOT NULL AND to_email != ''`
        ).all() as Array<{ e: string }>).map(r => r.e)
      );
      const seen = new Set<string>();
      const skipped: Array<{ name: string; email: string; error: string }> = [];
      const validRecipients = recipients.filter(r => {
        if (!r.email) return false;
        const key = r.email.trim().toLowerCase();
        if (alreadyContacted.has(key)) { skipped.push({ name: r.name, email: r.email, error: 'Bereits kontaktiert – übersprungen (kein Doppel-Versand)' }); return false; }
        if (seen.has(key)) { skipped.push({ name: r.name, email: r.email, error: 'Doppelter Empfänger in der Liste – übersprungen' }); return false; }
        seen.add(key);
        return true;
      });

      // Zeitversetzter Versand: geplante Einträge anlegen, der scheduled-sender Worker verschickt sie.
      if (scheduleAt) {
        const iso = resolveScheduleIso(scheduleAt);
        if (!iso) return reply.status(400).send({ error: 'Ungültige Versandzeit' });
        if (new Date(iso).getTime() < Date.now() - 60_000) return reply.status(400).send({ error: 'Versandzeit liegt in der Vergangenheit' });
        if (!validRecipients.length) return reply.status(400).send({ error: skipped.length ? 'Alle Empfänger wurden bereits kontaktiert' : 'Keine gültigen Empfänger' });
        const insert = getDb().prepare(
          `INSERT INTO scheduled_emails (id, lead_id, to_email, to_name, template_id, subject, body, campaign, scheduled_at, status)
           VALUES (@id, @lead_id, @to_email, @to_name, @template_id, @subject, @body, @campaign, @scheduled_at, 'scheduled')`
        );
        let scheduled = 0;
        for (const r of validRecipients) {
          const rendered = renderTemplate(template, r);
          insert.run({
            id: uuid(), lead_id: r.id ?? null, to_email: r.email, to_name: r.name ?? null,
            template_id: template.id, subject: rendered.subject, body: rendered.body,
            campaign: campaign ?? null, scheduled_at: iso,
          });
          scheduled++;
        }
        return { scheduled, skipped: skipped.length, skipped_details: skipped, scheduled_at: iso };
      }

      // Sofort-Versand.
      const results = [];
      for (const r of validRecipients) {
        const rendered = renderTemplate(template, r);
        const trackingId = uuid();
        // Mit Lead-ID: Status wird auf "contacted" gesetzt + Event protokolliert
        const res = r.id
          ? await sendLeadEmail({ leadId: r.id, to: r.email, toName: r.name, subject: rendered.subject, body: rendered.body, trackingId })
          : await sendBulkEmail({ to: r.email, toName: r.name, subject: rendered.subject, body: rendered.body, trackingId });
        recordSentEmail({ id: trackingId, lead_id: r.id ?? null, campaign: campaign ?? null, to_email: r.email, to_name: r.name, subject: rendered.subject, body: rendered.body, template_id: template.id, success: res.success, error: res.error, message_id: res.messageId });
        results.push({ name: r.name, email: r.email, success: res.success, error: res.error, messageId: res.messageId });
      }
      return {
        sent: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length,
        skipped: skipped.length,
        results: [...results, ...skipped.map(s => ({ ...s, success: false }))],
      };
    }
  );

  // ── Geplante E-Mails verwalten ────────────────────────────────────────────
  app.get('/api/scheduled-emails', async () => {
    const rows = getDb().prepare(
      `SELECT * FROM scheduled_emails ORDER BY
         CASE status WHEN 'scheduled' THEN 0 WHEN 'processing' THEN 1 ELSE 2 END,
         scheduled_at ASC`
    ).all() as any[];
    return rows.map(r => ({
      ...r,
      scheduled_at_local: berlinLabel(r.scheduled_at),
      sent_at_local: berlinLabel(r.sent_at),
    }));
  });

  app.patch<{ Params: { id: string }; Body: { subject?: string; body?: string; to_email?: string; to_name?: string; scheduleAt?: string } }>(
    '/api/scheduled-emails/:id',
    async (req, reply) => {
      const db = getDb();
      const row = db.prepare(`SELECT * FROM scheduled_emails WHERE id = ?`).get(req.params.id) as any;
      if (!row) return reply.status(404).send({ error: 'Nicht gefunden' });
      if (row.status !== 'scheduled') return reply.status(400).send({ error: 'Nur geplante E-Mails können bearbeitet werden' });
      const fields: Record<string, unknown> = {};
      if (typeof req.body.subject === 'string') fields.subject = req.body.subject;
      if (typeof req.body.body === 'string') fields.body = req.body.body;
      if (typeof req.body.to_email === 'string' && req.body.to_email.trim()) fields.to_email = req.body.to_email.trim();
      if (typeof req.body.to_name === 'string') fields.to_name = req.body.to_name;
      if (req.body.scheduleAt) {
        const iso = resolveScheduleIso(req.body.scheduleAt);
        if (!iso) return reply.status(400).send({ error: 'Ungültige Versandzeit' });
        if (new Date(iso).getTime() < Date.now() - 60_000) return reply.status(400).send({ error: 'Versandzeit liegt in der Vergangenheit' });
        fields.scheduled_at = iso;
      }
      if (!Object.keys(fields).length) return { ok: true, unchanged: true };
      fields.updated_at = new Date().toISOString();
      const sets = Object.keys(fields).map(k => `${k} = @${k}`).join(', ');
      db.prepare(`UPDATE scheduled_emails SET ${sets} WHERE id = @id`).run({ ...fields, id: req.params.id });
      return { ok: true };
    }
  );

  app.delete<{ Params: { id: string } }>('/api/scheduled-emails/:id', async (req, reply) => {
    const db = getDb();
    const row = db.prepare(`SELECT status FROM scheduled_emails WHERE id = ?`).get(req.params.id) as { status?: string } | undefined;
    if (!row) return reply.status(404).send({ error: 'Nicht gefunden' });
    if (row.status === 'scheduled' || row.status === 'failed') {
      db.prepare(`UPDATE scheduled_emails SET status = 'canceled', updated_at = @now WHERE id = @id`).run({ id: req.params.id, now: new Date().toISOString() });
      return { ok: true, canceled: true };
    }
    return reply.status(400).send({ error: 'Versand läuft bereits oder ist abgeschlossen' });
  });

  // ── Tracking (Öffnungs-Pixel + Klick-Redirect) ────────────────────────────
  const TRANSPARENT_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

  function logEmailEvent(sentEmailId: string, eventType: string, req: { headers: Record<string, unknown>; ip?: string }, url?: string) {
    // Nur Events für existierende Mails loggen (kein Müll von Scannern)
    const sent = getDb().prepare('SELECT sent_at FROM sent_emails WHERE id = ?').get(sentEmailId) as { sent_at?: string } | undefined;
    if (!sent) return false;
    const userAgent = String(req.headers['user-agent'] || '').slice(0, 300);
    const storedEventType = eventType === 'open'
      ? classifyOpenEvent({ userAgent, secondsSinceSent: secondsBetween(sent.sent_at, new Date().toISOString()) })
      : eventType === 'click'
        ? classifyClickEvent(userAgent)
        : eventType;
    getDb().prepare(
      `INSERT INTO email_events (id, sent_email_id, event_type, url, user_agent, ip)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(uuid(), sentEmailId, storedEventType, url ?? null, userAgent, req.ip ?? null);
    return true;
  }

  function urlPath(rawUrl: string | undefined): string | null {
    if (!rawUrl) return null;
    try { return new URL(rawUrl).pathname.slice(0, 240); } catch { return null; }
  }

  function inferWebChannel(source?: string | null, medium?: string | null, referrer?: string | null): string {
    const s = `${source || ''} ${medium || ''}`.toLowerCase();
    if (s.includes('email') || s.includes('mail')) return 'email';
    if (s.includes('sms') || s.includes('whatsapp')) return 'sms';
    if (!referrer) return 'direct';
    return 'organic';
  }

  function logWebVisit(data: {
    visitorId: string;
    channel?: string;
    source?: string | null;
    medium?: string | null;
    campaign?: string | null;
    sentEmailId?: string | null;
    leadId?: string | null;
    url: string;
    title?: string | null;
    referrer?: string | null;
    req: { headers: Record<string, unknown>; ip?: string };
  }) {
    const channel = (data.channel || inferWebChannel(data.source, data.medium, data.referrer)).slice(0, 40);
    getDb().prepare(
      `INSERT INTO web_visits (id, visitor_id, channel, source, medium, campaign, sent_email_id, lead_id, url, path, title, referrer, user_agent, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      uuid(),
      data.visitorId.slice(0, 120),
      channel,
      data.source?.slice(0, 120) ?? null,
      data.medium?.slice(0, 80) ?? null,
      data.campaign?.slice(0, 120) ?? null,
      data.sentEmailId ?? null,
      data.leadId ?? null,
      data.url.slice(0, 900),
      urlPath(data.url),
      data.title?.slice(0, 180) ?? null,
      data.referrer?.slice(0, 900) ?? null,
      String(data.req.headers['user-agent'] || '').slice(0, 300),
      data.req.ip ?? null
    );
  }

  app.get<{ Params: { id: string } }>('/t/o/:id', async (req, reply) => {
    const id = req.params.id.replace(/\.gif$/i, '');
    logEmailEvent(id, 'open', req as any);
    reply
      .header('Cache-Control', 'no-store, no-cache, must-revalidate, private')
      .header('Pragma', 'no-cache')
      .type('image/gif')
      .send(TRANSPARENT_GIF);
  });

  app.get<{ Params: { id: string } }>('/track/open/:id', async (req, reply) => {
    const id = req.params.id.replace(/\.gif$/i, '');
    logEmailEvent(id, 'open', req as any);
    reply
      .header('Cache-Control', 'no-store, no-cache, must-revalidate, private')
      .header('Pragma', 'no-cache')
      .type('image/gif')
      .send(TRANSPARENT_GIF);
  });

  app.get<{ Params: { id: string }; Querystring: { u?: string } }>('/t/c/:id', async (req, reply) => {
    const target = String(req.query.u || '').trim();
    // Nur echte http(s)-Ziele — kein offener Redirect für beliebige Schemata
    if (!/^https?:\/\//i.test(target)) return reply.status(400).send('Ungültiges Ziel');
    logEmailEvent(req.params.id, 'click', req as any, target.slice(0, 500));
    const sent = getDb().prepare('SELECT lead_id FROM sent_emails WHERE id = ?').get(req.params.id) as { lead_id?: string | null } | undefined;
    logWebVisit({
      visitorId: `email:${req.params.id}:${requestSignature(req as any)}`,
      channel: 'email',
      source: 'outreach_email',
      medium: 'email',
      sentEmailId: req.params.id,
      leadId: sent?.lead_id ?? null,
      url: target,
      referrer: null,
      req: req as any,
    });
    reply.redirect(302, target);
  });

  app.get<{ Params: { id: string }; Querystring: { u?: string } }>('/track/click/:id', async (req, reply) => {
    const target = String(req.query.u || '').trim();
    // Nur echte http(s)-Ziele — kein offener Redirect für beliebige Schemata
    if (!/^https?:\/\//i.test(target)) return reply.status(400).send('Ungültiges Ziel');
    logEmailEvent(req.params.id, 'click', req as any, target.slice(0, 500));
    const sent = getDb().prepare('SELECT lead_id FROM sent_emails WHERE id = ?').get(req.params.id) as { lead_id?: string | null } | undefined;
    logWebVisit({
      visitorId: `email:${req.params.id}:${requestSignature(req as any)}`,
      channel: 'email',
      source: 'outreach_email',
      medium: 'email',
      sentEmailId: req.params.id,
      leadId: sent?.lead_id ?? null,
      url: target,
      referrer: null,
      req: req as any,
    });
    reply.redirect(302, target);
  });

  // ── Analyse ───────────────────────────────────────────────────────────────
  app.get<{ Params: { id: string }; Querystring: { u?: string } }>('/track/sms/:id', async (req, reply) => {
    const target = String(req.query.u || '').trim();
    if (!/^https?:\/\//i.test(target)) return reply.status(400).send('Ungueltiges Ziel');
    logWebVisit({
      visitorId: `sms:${req.params.id}:${requestSignature(req as any)}`,
      channel: 'sms',
      source: 'voice_agent_sms',
      medium: 'sms',
      url: target,
      referrer: null,
      req: req as any,
    });
    reply.redirect(302, target);
  });

  app.get('/track.js', async (_req, reply) => {
    const js = `(() => {
  const endpoint = '${getTrackingBaseUrl() || ''}/webhook/visit';
  if (!endpoint || !navigator.sendBeacon) return;
  const key = 'tawano_visitor_id';
  const id = localStorage.getItem(key) || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
  localStorage.setItem(key, id);
  const params = new URLSearchParams(location.search);
  const body = JSON.stringify({
    visitor_id: id,
    url: location.href,
    title: document.title,
    referrer: document.referrer || '',
    source: params.get('utm_source') || '',
    medium: params.get('utm_medium') || '',
    campaign: params.get('utm_campaign') || ''
  });
  navigator.sendBeacon(endpoint, new Blob([body], { type: 'application/json' }));
})();`;
    reply.type('application/javascript').header('Cache-Control', 'public, max-age=300').send(js);
  });

  app.post<{ Body: { visitor_id?: string; url?: string; title?: string; referrer?: string; source?: string; medium?: string; campaign?: string } }>('/webhook/visit', async (req, reply) => {
    const body = req.body || {};
    const url = String(body.url || '').trim();
    if (!/^https?:\/\//i.test(url)) return reply.status(400).send({ ok: false, error: 'invalid_url' });
    logWebVisit({
      visitorId: String(body.visitor_id || `anon:${requestSignature(req as any)}`),
      source: body.source || null,
      medium: body.medium || null,
      campaign: body.campaign || null,
      url,
      title: body.title || null,
      referrer: body.referrer || null,
      req: req as any,
    });
    return { ok: true };
  });

  app.get<{ Querystring: Record<string, string> }>('/api/analytics/email', async (req) => {
    const db = getDb();
    const q = req.query || {};
    const fromIso = q.from ? (resolveScheduleIso(q.from) || null) : null;
    const toIso = q.to ? (resolveScheduleIso(q.to) || null) : null;
    const fTemplate = (q.template || '').trim();
    const fCampaign = (q.campaign || '').trim();
    const fSearch = (q.search || '').trim().toLowerCase();
    const fStatus = (q.status || '').trim();       // EmailStatusCode
    const fOpen = (q.open || '').trim();            // opened | not_opened | auto
    const fClick = (q.click || '').trim();          // clicked | not_clicked
    const inRange = (ts: unknown): boolean => {
      const d = parseDbTime(ts)?.getTime();
      if (d == null) return false;
      if (fromIso && d < new Date(fromIso).getTime()) return false;
      if (toIso && d > new Date(toIso).getTime()) return false;
      return true;
    };
    const sig = (e: { user_agent?: string | null; ip?: string | null }) => `${e.user_agent || 'unknown'}|${e.ip || 'unknown'}`;

    // ── Basis-Set aus sent_emails laden (SQL-Filter für Zeit/Vorlage/Kampagne/Suche) ──
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (fromIso) { where.push(`s.sent_at >= @from`); params.from = fromIso.replace('T', ' ').replace('Z', ''); }
    if (toIso) { where.push(`s.sent_at <= @to`); params.to = toIso.replace('T', ' ').replace('Z', ''); }
    if (fTemplate) { where.push(`s.template_id = @tpl`); params.tpl = fTemplate; }
    if (fCampaign) { where.push(fCampaign === '__none__' ? `s.campaign IS NULL` : `s.campaign = @camp`); if (fCampaign !== '__none__') params.camp = fCampaign; }
    // Datumsvergleich robust über parseDbTime unten nochmal; SQL-Grobfilter reicht als Vorauswahl.
    const rows = db.prepare(
      `SELECT s.id, s.to_email, s.to_name, s.subject, s.success, s.error, s.sent_at, s.job_id, s.scheduled_id, s.campaign, s.template_id
       FROM sent_emails s ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY s.sent_at DESC LIMIT 2000`
    ).all(params) as any[];
    const baseRows = rows.filter(r =>
      (!fromIso && !toIso ? true : inRange(r.sent_at)) &&
      (!fSearch || `${r.to_name || ''} ${r.to_email || ''} ${r.subject || ''}`.toLowerCase().includes(fSearch))
    );
    const idSet = new Set(baseRows.map(r => r.id));

    // ── Events für dieses Set laden ──
    const allEvents = idSet.size
      ? (db.prepare(
          `SELECT e.sent_email_id, e.event_type, e.url, e.user_agent, e.ip, e.created_at
           FROM email_events e WHERE e.sent_email_id IN (${[...idSet].map(() => '?').join(',')})`
        ).all(...idSet) as Array<{ sent_email_id: string; event_type: string; url?: string | null; user_agent?: string | null; ip?: string | null; created_at: string }>)
      : [];
    const evByMail = new Map<string, typeof allEvents>();
    for (const e of allEvents) {
      const arr = evByMail.get(e.sent_email_id) || [];
      arr.push(e); evByMail.set(e.sent_email_id, arr);
    }

    const tplNameMap = new Map<string, string>(
      (db.prepare(`SELECT id, name FROM email_templates`).all() as Array<{ id: string; name: string }>).map(t => [t.id, t.name])
    );

    // ── Pro Mail auswerten ──
    type MailOut = any;
    const emailsAll: MailOut[] = baseRows.map(row => {
      const evs = evByMail.get(row.id) || [];
      const openLike = evs.filter(e => isOpenLikeEvent(e.event_type));
      const reliable = openLike.filter(e => isReliableOpen({ event_type: e.event_type, user_agent: e.user_agent, secondsSinceSent: secondsBetween(row.sent_at, e.created_at) }));
      const technical = openLike.filter(e => !reliable.includes(e));
      // Nur echte Klicks zählen: Maschinen-/Scanner-Klicks (auch als 'click' gespeicherte Alt-Daten)
      // werden ausgeschlossen, damit Mailscanner die Statistik nicht aufblähen.
      const clickEvents = evs.filter(e => isRealClick({ event_type: e.event_type, user_agent: e.user_agent }));
      const machineClickEvents = evs.filter(e => isClickLikeEvent(e.event_type) && !isRealClick({ event_type: 'click', user_agent: e.user_agent }));
      const bounceEvents = evs.filter(e => e.event_type === 'bounce');
      const opensDistinct = countDistinctOpens(reliable.map(e => ({ signature: sig(e), created_at: e.created_at })));
      const clicksDistinct = countDistinctClicks(clickEvents.map(e => ({ url: e.url, signature: sig(e), created_at: e.created_at })));
      const uniqueOpen = reliable.length > 0;
      const uniqueClick = clickEvents.length > 0;
      const firstOpen = reliable.map(e => e.created_at).sort()[0] || null;
      const lastOpen = reliable.map(e => e.created_at).sort().slice(-1)[0] || null;
      // Pro Link entdoppelt zählen (gleiches Gerät + kurzes Zeitfenster = ein Klick).
      const clicksByUrl = new Map<string, typeof clickEvents>();
      for (const e of clickEvents) {
        const u = e.url || '(unbekannt)';
        const arr = clicksByUrl.get(u) || []; arr.push(e); clicksByUrl.set(u, arr);
      }
      const clickedLinks = [...clicksByUrl.entries()].map(([url, urlEvents]) => {
        const last = urlEvents.map(e => e.created_at).sort().slice(-1)[0];
        return {
          url,
          clicks: countDistinctClicks(urlEvents.map(e => ({ url, signature: sig(e), created_at: e.created_at }))),
          last,
          last_local: berlinLabel(last),
        };
      });
      const status = classifyEmailDelivery({
        success: row.success, error: row.error,
        hasBounce: bounceEvents.length > 0, bounceText: bounceEvents.map(b => b.user_agent).join(' '),
        opened: uniqueOpen, clicked: uniqueClick,
      });
      return {
        id: row.id, to_email: row.to_email, to_name: row.to_name, subject: row.subject,
        success: row.success, error: row.error, sent_at: row.sent_at, job_id: row.job_id,
        scheduled_id: row.scheduled_id, campaign: row.campaign,
        template_id: row.template_id, template_name: tplNameMap.get(row.template_id) || (row.template_id || '—'),
        opens: opensDistinct, unique_open: uniqueOpen, raw_opens: openLike.length, technical_opens: technical.length,
        clicks: clicksDistinct, raw_clicks: clickEvents.length, machine_clicks: machineClickEvents.length, unique_click: uniqueClick,
        bounces: bounceEvents.length,
        first_open: firstOpen, last_open: lastOpen,
        first_open_local: berlinLabel(firstOpen), last_open_local: berlinLabel(lastOpen),
        devices: new Set(reliable.map(e => e.user_agent || 'unknown')).size,
        clicked_links: clickedLinks,
        status_code: status.code, status_label: status.label, status_tone: status.tone,
        status_explanation: status.explanation, status_recommendation: status.recommendation,
        open_status: uniqueOpen ? 'opened' : technical.length > 0 ? 'auto' : 'not_opened',
        sent_at_local: berlinLabel(row.sent_at),
      };
    });

    // ── KPIs über das Basis-Set (vor Tabellen-Feinfilter) ──
    const attempted = emailsAll.length;
    const failedSend = emailsAll.filter(m => m.success === 0).length;
    const bouncedN = emailsAll.filter(m => m.bounces > 0).length;
    const delivered = emailsAll.filter(m => m.success === 1 && m.bounces === 0).length;
    const openedUnique = emailsAll.filter(m => m.unique_open).length;
    const opensTotal = emailsAll.reduce((s, m) => s + m.opens, 0);
    const clickedUnique = emailsAll.filter(m => m.unique_click).length;
    const clicksTotal = emailsAll.reduce((s, m) => s + m.clicks, 0);
    const okCount = emailsAll.filter(m => m.success === 1).length;

    // ── Tabellen-Feinfilter (Status/Öffnung/Klick) ──
    const emails = emailsAll.filter(m => {
      if (fStatus && m.status_code !== fStatus) return false;
      if (fOpen === 'opened' && !m.unique_open) return false;
      if (fOpen === 'not_opened' && m.unique_open) return false;
      if (fOpen === 'auto' && !(m.open_status === 'auto')) return false;
      if (fClick === 'clicked' && !m.unique_click) return false;
      if (fClick === 'not_clicked' && m.unique_click) return false;
      return true;
    });

    // ── Vorperioden-Vergleich (gleich lange Periode davor) ──
    let prev: any = null;
    if (fromIso && toIso) {
      const span = new Date(toIso).getTime() - new Date(fromIso).getTime();
      const pFrom = new Date(new Date(fromIso).getTime() - span);
      const pTo = new Date(fromIso);
      const pRows = db.prepare(
        `SELECT id, success FROM sent_emails WHERE sent_at >= @f AND sent_at < @t`
      ).all({ f: pFrom.toISOString().replace('T', ' ').replace('Z', ''), t: pTo.toISOString().replace('T', ' ').replace('Z', '') }) as any[];
      const pIds = new Set(pRows.map(r => r.id));
      // Echte Klicks (Scanner/Bots raus, auch bei Alt-Daten) statt rohem event_type='click'.
      const pClickEvents = pIds.size ? (db.prepare(`SELECT sent_email_id, user_agent FROM email_events WHERE event_type='click' AND sent_email_id IN (${[...pIds].map(() => '?').join(',')})`).all(...pIds) as Array<{ sent_email_id: string; user_agent?: string | null }>) : [];
      const pClicks = new Set(pClickEvents.filter(e => isRealClick({ event_type: 'click', user_agent: e.user_agent })).map(e => e.sent_email_id)).size;
      prev = { attempted: pRows.length, delivered: pRows.filter(r => r.success === 1).length, clicked: pClicks };
    }

    // ── Charts: Versand/Öffnungen pro Tag über die gewählte Periode (max 30 Tage) ──
    const rangeDays = fromIso && toIso
      ? Math.min(30, Math.max(1, Math.round((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 86400000) + 1))
      : 14;
    const dayKeyMap = new Map<string, { sent: number; opened: number }>();
    for (const m of emailsAll) {
      const day = berlinParts(m.sent_at)?.day; if (!day) continue;
      const d = dayKeyMap.get(day) || { sent: 0, opened: 0 };
      d.sent++; if (m.unique_open) d.opened++;
      dayKeyMap.set(day, d);
    }
    const days: Array<{ day: string; sent: number; opened: number }> = [];
    const anchor = toIso ? new Date(toIso) : new Date();
    for (let i = rangeDays - 1; i >= 0; i--) {
      const d = new Date(anchor); d.setDate(d.getDate() - i);
      const day = berlinParts(d.toISOString())?.day || d.toISOString().slice(0, 10);
      const hit = dayKeyMap.get(day) || { sent: 0, opened: 0 };
      days.push({ day, sent: hit.sent, opened: hit.opened });
    }
    const opensByHour = Array.from({ length: 24 }, () => 0);
    for (const m of emailsAll) {
      if (!m.first_open) continue;
      const parts = berlinParts(m.first_open);
      if (parts && Number.isFinite(parts.hour)) opensByHour[parts.hour]++;
    }

    // ── Top-Vorlagen ──
    const tplAgg = new Map<string, { id: string; name: string; sent: number; opened: number; clicked: number }>();
    for (const m of emailsAll) {
      const id = m.template_id || '—';
      const a = tplAgg.get(id) || { id, name: m.template_name, sent: 0, opened: 0, clicked: 0 };
      a.sent++; if (m.unique_open) a.opened++; if (m.unique_click) a.clicked++;
      tplAgg.set(id, a);
    }
    const topTemplates = [...tplAgg.values()].sort((a, b) => b.sent - a.sent).slice(0, 8);

    // ── Top-Kampagnen ──
    const campAgg = new Map<string, { campaign: string; sent: number; opened: number; clicked: number }>();
    for (const m of emailsAll) {
      if (!m.campaign) continue;
      const a = campAgg.get(m.campaign) || { campaign: m.campaign, sent: 0, opened: 0, clicked: 0 };
      a.sent++; if (m.unique_open) a.opened++; if (m.unique_click) a.clicked++;
      campAgg.set(m.campaign, a);
    }
    const topCampaigns = [...campAgg.values()].sort((a, b) => b.clicked - a.clicked || b.sent - a.sent).slice(0, 8);

    // ── Top-Links + Empfänger mit Klicks ──
    const linkAgg = new Map<string, { url: string; clicks: number; recipients: Set<string> }>();
    for (const m of emailsAll) {
      for (const l of m.clicked_links) {
        const a = linkAgg.get(l.url) || { url: l.url, clicks: 0, recipients: new Set<string>() };
        a.clicks += l.clicks; a.recipients.add(m.to_email);
        linkAgg.set(l.url, a);
      }
    }
    const topLinks = [...linkAgg.values()].map(a => ({ url: a.url, clicks: a.clicks, recipients: a.recipients.size })).sort((a, b) => b.clicks - a.clicks).slice(0, 10);
    const recipientsClicked = emailsAll.filter(m => m.unique_click)
      .map(m => ({ to_name: m.to_name, to_email: m.to_email, clicks: m.clicks, last: m.clicked_links.map((l: any) => l.last).sort().slice(-1)[0] || null, subject: m.subject }))
      .map(r => ({ ...r, last_local: berlinLabel(r.last) }))
      .sort((a, b) => b.clicks - a.clicks).slice(0, 25);

    // ── Geplante E-Mails (KPI + optionale Tabellenzeilen) ──
    const scheduledRows = db.prepare(
      `SELECT id, to_email, to_name, subject, template_id, campaign, scheduled_at, status, error FROM scheduled_emails
       WHERE status IN ('scheduled','processing') ORDER BY scheduled_at ASC LIMIT 200`
    ).all() as any[];
    const scheduledCount = scheduledRows.length;
    const scheduled = scheduledRows.map(r => ({
      ...r, scheduled_at_local: berlinLabel(r.scheduled_at),
      template_name: tplNameMap.get(r.template_id) || (r.template_id || '—'),
    }));

    // ── Filter-Optionen für die UI ──
    const templateOptions = [...tplNameMap.entries()].map(([id, name]) => ({ id, name }));
    const campaignOptions = (db.prepare(`SELECT DISTINCT campaign FROM sent_emails WHERE campaign IS NOT NULL AND campaign != '' ORDER BY campaign`).all() as Array<{ campaign: string }>).map(c => c.campaign);

    const totals = {
      sent: attempted, ok: okCount, failed: failedSend, delivered, bounced: bouncedN,
      opened: openedUnique, opens_total: opensTotal, technical_opened: emailsAll.reduce((s, m) => s + m.technical_opens, 0),
      clicked: clickedUnique, clicks_total: clicksTotal, unsubscribed: 0, scheduled: scheduledCount,
    };

    const webTotal = (db.prepare(`SELECT COUNT(*) as n FROM web_visits`).get() as { n: number }).n;
    const webVisitors = (db.prepare(`SELECT COUNT(DISTINCT visitor_id) as n FROM web_visits`).get() as { n: number }).n;
    const webByChannel = db.prepare(
      `SELECT channel, COUNT(*) as visits, COUNT(DISTINCT visitor_id) as visitors
       FROM web_visits GROUP BY channel ORDER BY visits DESC`
    ).all();
    const webTopPages = db.prepare(
      `SELECT COALESCE(path, url) as path, COUNT(*) as visits, COUNT(DISTINCT visitor_id) as visitors
       FROM web_visits GROUP BY COALESCE(path, url) ORDER BY visits DESC LIMIT 8`
    ).all();
    const hotVisitors = db.prepare(
      `SELECT visitor_id, channel, MAX(created_at) as last_seen, COUNT(*) as visits,
              COUNT(DISTINCT path) as pages,
              SUM(CASE WHEN sent_email_id IS NOT NULL THEN 1 ELSE 0 END) as email_touches,
              SUM(CASE WHEN channel = 'sms' THEN 1 ELSE 0 END) as sms_touches,
              MAX(url) as last_url
       FROM web_visits
       GROUP BY visitor_id, channel
       ORDER BY (COUNT(*) + COUNT(DISTINCT path) * 2 + SUM(CASE WHEN sent_email_id IS NOT NULL THEN 4 ELSE 0 END) + SUM(CASE WHEN channel = 'sms' THEN 4 ELSE 0 END)) DESC, MAX(created_at) DESC
       LIMIT 12`
    ).all() as any[];

    const base = getTrackingBaseUrl();
    const isPublic = Boolean(base) && !/localhost|127\.0\.0\.1|192\.168\.|^$/.test(base);
    const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);
    return {
      totals,
      rates: {
        delivery_rate: pct(delivered, attempted),
        open_rate: pct(openedUnique, delivered || okCount),
        click_rate: pct(clickedUnique, delivered || okCount),
        click_to_open_rate: pct(clickedUnique, openedUnique),
        bounce_rate: pct(bouncedN, attempted),
        fail_rate: pct(failedSend, attempted),
      },
      // Rückwärtskompatible Felder:
      open_rate: pct(openedUnique, delivered || okCount),
      click_rate: pct(clickedUnique, delivered || okCount),
      previous: prev,
      filters: { templates: templateOptions, campaigns: campaignOptions },
      top_templates: topTemplates,
      top_campaigns: topCampaigns,
      top_links: topLinks,
      recipients_clicked: recipientsClicked,
      scheduled,
      opens_by_hour: opensByHour,
      days,
      emails,
      web: {
        total: webTotal,
        visitors: webVisitors,
        by_channel: webByChannel,
        top_pages: webTopPages,
        hot_visitors: hotVisitors.map(v => ({
          ...v,
          last_seen_local: berlinLabel(v.last_seen),
          intent_score: Math.min(100, Number(v.visits || 0) * 8 + Number(v.pages || 0) * 12 + Number(v.email_touches || 0) * 20 + Number(v.sms_touches || 0) * 20),
        })),
        track_script: base ? `<script async src="${base}/track.js"></script>` : null,
        sms_link_format: base ? `${base}/track/sms/{sms_id}?u=${encodeURIComponent('https://deine-zielseite.de')}` : null,
      },
      tracking: { base_url: base || null, public: isPublic },
    };
  });

  app.get<{ Params: { id: string } }>('/api/analytics/email/:id/events', async (req) => {
    const db = getDb();
    const sent = db.prepare(
      `SELECT s.*, sch.scheduled_at, sch.status as sched_status FROM sent_emails s
       LEFT JOIN scheduled_emails sch ON sch.sent_email_id = s.id WHERE s.id = ?`
    ).get(req.params.id) as any;
    const rawEvents = db.prepare(
      `SELECT event_type, url, user_agent, created_at FROM email_events WHERE sent_email_id = ? ORDER BY created_at ASC`
    ).all(req.params.id) as any[];

    const LABELS: Record<string, string> = {
      open: 'Öffnung registriert',
      open_machine: 'Automatischer Abruf (kein Nachweis einer echten Öffnung)',
      open_unverified: 'Sehr früher Abruf – Öffnung nicht gesichert',
      click: 'Link angeklickt',
      click_machine: 'Automatischer Link-Scan (Mailscanner, kein echter Klick)',
      bounce: 'Zustellfehler (Bounce)',
    };
    const events = rawEvents.map((event) => {
      const secondsSinceSent = secondsBetween(sent?.sent_at, event.created_at);
      const effective_type = event.event_type === 'open'
        ? classifyOpenEvent({ userAgent: event.user_agent, secondsSinceSent })
        : event.event_type === 'click'
          ? classifyClickEvent(event.user_agent)
          : event.event_type;
      return {
        ...event,
        effective_type,
        label: LABELS[effective_type] || event.event_type,
        seconds_since_sent: secondsSinceSent,
        created_at_local: berlinLabel(event.created_at),
      };
    });

    // Kompakte, verständliche Ereignis-Timeline (Meilensteine).
    const hasBounce = rawEvents.some(e => e.event_type === 'bounce');
    const hasOpen = events.some(e => e.effective_type === 'open');
    const firstClick = rawEvents.find(e => isRealClick({ event_type: e.event_type, user_agent: e.user_agent }));
    const firstOpen = events.find(e => e.effective_type === 'open');
    const timeline: Array<{ key: string; label: string; at: string | null; at_local: string | null; done: boolean; tone: string }> = [];
    if (sent?.scheduled_at) timeline.push({ key: 'scheduled', label: 'Versand geplant', at: sent.scheduled_at, at_local: berlinLabel(sent.scheduled_at), done: true, tone: 'info' });
    timeline.push({ key: 'handed', label: 'An Versanddienst übergeben', at: sent?.sent_at || null, at_local: berlinLabel(sent?.sent_at), done: sent?.success === 1, tone: sent?.success === 1 ? 'ok' : 'bad' });
    if (hasBounce) {
      timeline.push({ key: 'bounce', label: 'Zustellung fehlgeschlagen', at: rawEvents.find(e => e.event_type === 'bounce')!.created_at, at_local: berlinLabel(rawEvents.find(e => e.event_type === 'bounce')!.created_at), done: true, tone: 'bad' });
    } else {
      timeline.push({ key: 'delivered', label: hasOpen || firstClick ? 'Zugestellt (belegt durch Interaktion)' : 'Zustellung angenommen', at: firstOpen?.created_at || firstClick?.created_at || null, at_local: berlinLabel(firstOpen?.created_at || firstClick?.created_at), done: sent?.success === 1, tone: sent?.success === 1 ? 'good' : 'info' });
    }
    timeline.push({ key: 'open', label: 'Öffnung registriert', at: firstOpen?.created_at || null, at_local: berlinLabel(firstOpen?.created_at), done: hasOpen, tone: hasOpen ? 'good' : 'muted' });
    timeline.push({ key: 'click', label: firstClick ? `Link angeklickt${firstClick.url ? ' → ' + String(firstClick.url).slice(0, 80) : ''}` : 'Link angeklickt', at: firstClick?.created_at || null, at_local: berlinLabel(firstClick?.created_at), done: Boolean(firstClick), tone: firstClick ? 'good' : 'muted' });

    return { events, timeline };
  });

  // Posteingang nach Zustellfehlern (Bounces) durchsuchen und zuordnen
  app.post('/api/analytics/scan-bounces', async () => {
    const db = getDb();
    let mails: Awaited<ReturnType<typeof fetchInboxEmails>> = [];
    try { mails = await fetchInboxEmails(60); } catch { return { scanned: 0, found: 0, matched: 0, error: 'Posteingang nicht erreichbar' }; }

    const dsn = mails.filter(m =>
      /mailer-daemon|postmaster|delivery status|mail delivery/i.test(m.from + ' ' + m.fromName) ||
      /delivery status notification|undelivered|failure|zustellung fehlgeschlagen|unzustellbar/i.test(m.subject)
    );

    let matched = 0;
    for (const m of dsn) {
      const addresses = [...new Set((m.body.match(/[\w.+-]+@[\w.-]+\.\w+/g) || [])
        .map(a => a.toLowerCase())
        .filter(a => !/mailer-daemon|postmaster/.test(a) && a !== (process.env.SMTP_USER || '').toLowerCase()))];
      for (const addr of addresses) {
        const sent = db.prepare(
          `SELECT id FROM sent_emails WHERE LOWER(to_email) = ? ORDER BY sent_at DESC LIMIT 1`
        ).get(addr) as { id: string } | undefined;
        if (!sent) continue;
        const already = db.prepare(
          `SELECT 1 FROM email_events WHERE sent_email_id = ? AND event_type = 'bounce'`
        ).get(sent.id);
        if (already) continue;
        db.prepare(
          `INSERT INTO email_events (id, sent_email_id, event_type, url, user_agent, ip)
           VALUES (?, ?, 'bounce', ?, ?, NULL)`
        ).run(uuid(), sent.id, null, ('DSN: ' + m.subject).slice(0, 300));
        matched++;
      }
    }
    return { scanned: mails.length, found: dsn.length, matched };
  });

  app.get('/api/analytics/sms', async () => getSmsAnalytics());

  // ── Follow-up-Sequenz (Nachfass-Mails) ────────────────────────────────────
  app.get('/api/followup/stats', async () => followupStats());

  app.patch<{ Body: Partial<{ enabled: boolean; gap1_days: number; gap2_days: number; daily_cap: number; window_start: number; window_end: number; min_gap_s: number }> }>(
    '/api/followup/config',
    async (req) => {
      setFollowupConfig(req.body || {});
      return followupStats();
    }
  );

  app.get('/api/followup/config', async () => getFollowupConfig());

  // Kontaktierte Firmen + Engagement-Signale (Klick/Besuch/Antwort) + Follow-up-Zustand.
  // Öffnungen bewusst nur als schwacher Indikator, nicht als Vertrauensmetrik.
  app.get('/api/followup/leads', async () => {
    const db = getDb();
    const cfg = getFollowupConfig();
    const MAX_STAGES = 2;
    const OUT = ['contacted', 'replied', 'demo_booked', 'proposal_sent', 'won', 'lost', 'no_interest'];
    const leads = db.prepare(
      `SELECT id, name, branche, stadt, email, status, followup_stage, followup_stopped, followup_stopped_reason,
              followup_last_at, gesendet_at, contacted_at, updated_at
       FROM leads WHERE status IN (${OUT.map(() => '?').join(',')})`
    ).all(...OUT) as any[];
    if (!leads.length) return { leads: [], summary: { contacted: 0, hot: 0, clicked: 0, visited: 0, replied: 0, in_sequence: 0, stopped: 0 }, config: cfg };

    const ids = leads.map(l => l.id);
    const ph = ids.map(() => '?').join(',');
    const events = db.prepare(
      `SELECT se.lead_id, ev.event_type, ev.url, ev.user_agent, ev.ip, ev.created_at, se.sent_at
       FROM email_events ev JOIN sent_emails se ON se.id = ev.sent_email_id
       WHERE se.lead_id IN (${ph})`
    ).all(...ids) as Array<{ lead_id: string; event_type: string; url: string | null; user_agent: string | null; ip: string | null; created_at: string; sent_at: string }>;
    const visits = db.prepare(
      `SELECT lead_id, COUNT(*) n, MAX(created_at) last FROM web_visits WHERE lead_id IN (${ph}) GROUP BY lead_id`
    ).all(...ids) as Array<{ lead_id: string; n: number; last: string }>;

    const evByLead = new Map<string, typeof events>();
    for (const e of events) { const a = evByLead.get(e.lead_id) || []; a.push(e); evByLead.set(e.lead_id, a); }
    const visitByLead = new Map(visits.map(v => [v.lead_id, v]));
    const sig = (e: { user_agent?: string | null; ip?: string | null }) => `${e.user_agent || 'unknown'}|${e.ip || 'unknown'}`;

    const rows = leads.map(l => {
      const evs = evByLead.get(l.id) || [];
      const realClicks = evs.filter(e => isRealClick({ event_type: e.event_type, user_agent: e.user_agent }));
      const reliableOpens = evs.filter(e => isReliableOpen({ event_type: e.event_type, user_agent: e.user_agent, secondsSinceSent: secondsBetween(e.sent_at, e.created_at) }));
      const bounced = evs.some(e => e.event_type === 'bounce');
      const v = visitByLead.get(l.id);
      const stage = l.followup_stage || 0;
      const replied = ['replied', 'demo_booked', 'proposal_sent', 'won'].includes(l.status);
      const clicks = countDistinctClicks(realClicks.map(e => ({ url: e.url, signature: sig(e), created_at: e.created_at })));
      const opens = countDistinctOpens(reliableOpens.map(e => ({ signature: sig(e), created_at: e.created_at })));
      const visitCount = v ? v.n : 0;
      const clicked = clicks > 0;
      const visited = visitCount > 0;

      let nextDue: string | null = null;
      if (!l.followup_stopped && stage < MAX_STAGES && l.status === 'contacted') {
        const gap = stage === 0 ? cfg.gap1_days : cfg.gap2_days;
        const last = l.followup_last_at || l.gesendet_at || l.contacted_at;
        if (last) nextDue = new Date(new Date(String(last).replace(' ', 'T')).getTime() + gap * 86_400_000).toISOString();
      }
      return {
        id: l.id, name: l.name, branche: l.branche, stadt: l.stadt, email: l.email, status: l.status,
        followup_stage: stage, followup_stopped: l.followup_stopped ? 1 : 0, followup_stopped_reason: l.followup_stopped_reason,
        contacted_at: l.gesendet_at || l.contacted_at, last_touch: l.followup_last_at || l.gesendet_at || l.contacted_at,
        clicked, clicks, visited, visits: visitCount, visited_last: v ? v.last : null, replied, bounced,
        opens_reliable: opens,
        hot: clicked || visited || replied,
        next_due_at: nextDue,
        followup_done: stage >= MAX_STAGES,
      };
    });

    // Sortierung: heiße Leads (Klick/Besuch/Antwort) zuerst, dann bald fällige Follow-ups, dann zuletzt berührt.
    rows.sort((a, b) =>
      (b.hot ? 1 : 0) - (a.hot ? 1 : 0) ||
      (b.clicks - a.clicks) ||
      ((a.next_due_at ? new Date(a.next_due_at).getTime() : Infinity) - (b.next_due_at ? new Date(b.next_due_at).getTime() : Infinity)) ||
      (new Date(String(b.last_touch || 0)).getTime() - new Date(String(a.last_touch || 0)).getTime())
    );

    const summary = {
      contacted: rows.length,
      hot: rows.filter(r => r.hot).length,
      clicked: rows.filter(r => r.clicked).length,
      visited: rows.filter(r => r.visited).length,
      replied: rows.filter(r => r.replied).length,
      bounced: rows.filter(r => r.bounced).length,
      in_sequence: rows.filter(r => r.status === 'contacted' && !r.followup_stopped && r.followup_stage < MAX_STAGES).length,
      stopped: rows.filter(r => r.followup_stopped).length,
    };
    return { leads: rows, summary, config: cfg };
  });

  app.post<{ Body: { leadId: string; reason?: string } }>('/api/followup/stop', async (req, reply) => {
    if (!req.body?.leadId) return reply.status(400).send({ error: 'leadId fehlt' });
    getDb().prepare(`UPDATE leads SET followup_stopped = 1, followup_stopped_reason = @reason, updated_at = @now WHERE id = @id`)
      .run({ id: req.body.leadId, reason: (req.body.reason || 'Manuell gestoppt').slice(0, 200), now: new Date().toISOString() });
    return { ok: true };
  });

  app.post<{ Body: { leadId: string } }>('/api/followup/resume', async (req, reply) => {
    if (!req.body?.leadId) return reply.status(400).send({ error: 'leadId fehlt' });
    getDb().prepare(`UPDATE leads SET followup_stopped = 0, followup_stopped_reason = NULL, updated_at = @now WHERE id = @id`)
      .run({ id: req.body.leadId, now: new Date().toISOString() });
    return { ok: true };
  });

  // Manuelles Follow-up: der Nutzer wählt selbst Firmen + Vorlage und löst den Versand aus.
  // Bewusst OHNE den "bereits kontaktiert"-Schutz (das erneute Anschreiben ist hier gewollt),
  // aber mit hartem globalem Tageslimit als Konto-Schutz.
  app.post<{ Body: { leadIds: string[]; templateId?: string } }>(
    '/api/followup/send-manual',
    async (req, reply) => {
      const leadIds = Array.isArray(req.body?.leadIds) ? req.body.leadIds.filter(Boolean) : [];
      if (!leadIds.length) return reply.status(400).send({ error: 'Keine Firmen ausgewählt' });
      const tpl = (req.body?.templateId && getTemplateById(req.body.templateId)) || getEmailTemplate();
      const db = getDb();
      const results: Array<{ id: string; name?: string; success: boolean; error?: string }> = [];
      for (const id of leadIds) {
        const lead = db.prepare('SELECT id, name, branche, stadt, email, followup_stage FROM leads WHERE id = ?').get(id) as
          { id: string; name: string; branche?: string; stadt?: string; email?: string; followup_stage?: number } | undefined;
        if (!lead) { results.push({ id, success: false, error: 'Lead nicht gefunden' }); continue; }
        if (!lead.email) { results.push({ id, name: lead.name, success: false, error: 'Keine E-Mail' }); continue; }
        if (sentTodayCount() >= GLOBAL_DAILY_CAP) { results.push({ id, name: lead.name, success: false, error: `Globales Tageslimit (${GLOBAL_DAILY_CAP}) erreicht` }); continue; }
        const rendered = renderTemplate(tpl, { name: lead.name, branche: lead.branche, stadt: lead.stadt });
        const trackingId = uuid();
        let res;
        try {
          res = await sendBulkEmail({ to: lead.email, toName: lead.name, subject: rendered.subject, body: rendered.body, trackingId });
        } catch (err) {
          res = { success: false, error: err instanceof Error ? err.message : String(err) };
        }
        recordSentEmail({
          id: trackingId, lead_id: lead.id, campaign: 'followup-manual', to_email: lead.email, to_name: lead.name,
          subject: rendered.subject, body: rendered.body, template_id: tpl.id,
          success: res.success, error: res.error, message_id: (res as { messageId?: string }).messageId,
        });
        if (res.success) {
          const now = new Date().toISOString();
          db.prepare(`UPDATE leads SET followup_stage = COALESCE(followup_stage,0) + 1, followup_last_at = @now, updated_at = @now WHERE id = @id`)
            .run({ id: lead.id, now });
          recordOutreachEvent({
            lead_id: lead.id, event_type: 'followup_sent', channel: 'email', status: 'contacted', user: 'manual',
            note: `Manuelles Follow-up an ${lead.email} | Vorlage: "${tpl.name}" | Betreff: "${rendered.subject}"`,
          });
        }
        results.push({ id, name: lead.name, success: res.success, error: res.error });
      }
      return { sent: results.filter(r => r.success).length, failed: results.filter(r => !r.success).length, results };
    }
  );

  // Fertige Follow-up-Vorlagen bereitstellen (idempotent)
  seedFollowupTemplates();

  // Hintergrund-Worker starten
  startAutoSender();
  startScheduledSender();
  startFollowupSender();
}

function enrichLeads(leads: Lead[]) {
  if (!leads.length) return [];
  const ids = leads.map(l => l.id);
  const contactPointsMap = getContactPointsBatch(ids);
  const outreachEventsMap = getOutreachEventsBatch(ids);
  return leads.map(lead => ({
    ...lead,
    contact_points: contactPointsMap[lead.id] ?? [],
    outreach_events: outreachEventsMap[lead.id] ?? [],
  }));
}
