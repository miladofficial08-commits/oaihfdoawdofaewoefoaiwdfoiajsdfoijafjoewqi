import { FastifyInstance } from 'fastify';
import path from 'path';
import fs from 'fs';
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
} from '../db/leads-repo';
import { Lead } from '../types';
import { nrwRegions, verticalPresets } from '../config/markets';
import { runPipeline } from '../pipeline';
import { personalizeLead, getAiProvider } from '../ai/personalizer';
import { exportToCsv } from '../export/csv-export';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { getSmtpStatus, sendLeadEmail, sendBulkEmail, getTrackingBaseUrl } from '../email/mailer';
import { getSmsStats } from '../email/sms-stats';
import { generateAdVariants } from '../ai/ad-generator';
import { v4 as uuid } from 'uuid';
import { getDb } from '../db/schema';
import { fetchInboxEmails, getImapStatus, markEmailSeen } from '../email/inbox';
import { getEmailTemplate, updateEmailTemplate, renderTemplate, listEmailTemplates, createEmailTemplate, deleteEmailTemplate } from '../email/template';
import { startAutoSender, recordSentEmail, sentTodayCount, GLOBAL_DAILY_CAP, ALLOWED_DAILY_LIMITS, SendJob } from '../email/auto-sender';

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

  app.post<{ Body: { branche: string; stadt: string; bezirk?: string; max?: number; skipAi?: boolean } }>(
    '/api/run',
    async (req, reply) => {
      const { branche, stadt, bezirk, max = 25, skipAi = true } = req.body;
      if (!branche || !stadt) return reply.status(400).send({ error: 'branche und stadt sind Pflicht' });
      const result = await runPipeline({ branche, stadt, stadtbezirk: bezirk, maxResults: max }, {
        maxResults: max,
        skipAi,
      });
      return result;
    }
  );

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

  app.post<{ Body: { id: string; to: string; subject: string; body: string } }>(
    '/api/send-email',
    async (req, reply) => {
      const { id, to, subject, body } = req.body;
      if (!id || !to || !subject || !body) {
        return reply.status(400).send({ error: 'id, to, subject und body sind Pflicht' });
      }
      const trackingId = uuid();
      const result = await sendLeadEmail({ leadId: id, to, subject, body, trackingId });
      const lead = getAllLeads().find(l => l.id === id);
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

  app.post<{ Body: { name?: string; subject?: string; body?: string } }>(
    '/api/email-templates',
    async (req) => createEmailTemplate({
      name: req.body.name || 'Neue Vorlage',
      subject: req.body.subject || 'Betreff für {name}',
      body: req.body.body || 'Guten Tag {name}-Team,\n\n…\n\nMit freundlichen Grüßen\nTawano',
    })
  );

  app.put<{ Params: { id: string }; Body: { name?: string; subject?: string; body?: string } }>(
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

  app.post<{ Body: { name?: string; verticalId?: string; totalTarget: number; dailyLimit?: number; templateIds?: string[]; windowStart?: number; windowEnd?: number } }>(
    '/api/send-jobs',
    async (req, reply) => {
      const { name, verticalId, totalTarget, dailyLimit = 100, templateIds = ['default'], windowStart = 8, windowEnd = 20 } = req.body;
      if (!totalTarget || totalTarget < 1) return reply.status(400).send({ error: 'Anzahl E-Mails fehlt' });
      if (totalTarget > 5000) return reply.status(400).send({ error: 'Maximal 5000 E-Mails pro Job' });
      const safeDaily = ALLOWED_DAILY_LIMITS.includes(dailyLimit) ? dailyLimit : 100;
      const vertical = verticalPresets.find(v => v.id === verticalId);
      const id = uuid();
      getDb().prepare(
        `INSERT INTO send_jobs (id, name, vertical_id, branche_terms, template_ids, total_target, daily_limit, window_start, window_end, status, next_send_at)
         VALUES (@id, @name, @vertical_id, @branche_terms, @template_ids, @total_target, @daily_limit, @window_start, @window_end, 'running', datetime('now'))`
      ).run({
        id,
        name: name || (vertical ? vertical.label : 'Alle Branchen') + ' – ' + totalTarget + ' E-Mails',
        vertical_id: verticalId ?? null,
        branche_terms: vertical ? JSON.stringify(vertical.searchTerms) : null,
        template_ids: JSON.stringify(templateIds.length ? templateIds : ['default']),
        total_target: totalTarget,
        daily_limit: safeDaily,
        window_start: Math.max(0, Math.min(23, windowStart)),
        window_end: Math.max(1, Math.min(24, windowEnd)),
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

  // ── Bulk Send ─────────────────────────────────────────────────────────────
  app.post<{ Body: { recipients: Array<{ id?: string; name: string; email: string; branche?: string; stadt?: string }> } }>(
    '/api/bulk-send',
    async (req, reply) => {
      const { recipients } = req.body;
      if (!recipients?.length) return reply.status(400).send({ error: 'Empfänger fehlen' });
      const template = getEmailTemplate();
      const results = [];
      for (const r of recipients) {
        if (!r.email) { results.push({ name: r.name, email: '', success: false, error: 'Keine E-Mail' }); continue; }
        const rendered = renderTemplate(template, r);
        const trackingId = uuid();
        // Mit Lead-ID: Status wird auf "contacted" gesetzt + Event protokolliert
        const res = r.id
          ? await sendLeadEmail({ leadId: r.id, to: r.email, subject: rendered.subject, body: rendered.body, trackingId })
          : await sendBulkEmail({ to: r.email, subject: rendered.subject, body: rendered.body, trackingId });
        recordSentEmail({ id: trackingId, lead_id: r.id ?? null, to_email: r.email, to_name: r.name, subject: rendered.subject, body: rendered.body, template_id: template.id, success: res.success, error: res.error, message_id: res.messageId });
        results.push({ name: r.name, email: r.email, success: res.success, error: res.error, messageId: res.messageId });
      }
      return {
        sent: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length,
        results,
      };
    }
  );

  // ── Tracking (Öffnungs-Pixel + Klick-Redirect) ────────────────────────────
  const TRANSPARENT_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

  function logEmailEvent(sentEmailId: string, eventType: string, req: { headers: Record<string, unknown>; ip?: string }, url?: string) {
    // Nur Events für existierende Mails loggen (kein Müll von Scannern)
    const exists = getDb().prepare('SELECT 1 FROM sent_emails WHERE id = ?').get(sentEmailId);
    if (!exists) return false;
    getDb().prepare(
      `INSERT INTO email_events (id, sent_email_id, event_type, url, user_agent, ip)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(uuid(), sentEmailId, eventType, url ?? null, String(req.headers['user-agent'] || '').slice(0, 300), req.ip ?? null);
    return true;
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
    reply.redirect(302, target);
  });

  app.get<{ Params: { id: string }; Querystring: { u?: string } }>('/track/click/:id', async (req, reply) => {
    const target = String(req.query.u || '').trim();
    // Nur echte http(s)-Ziele — kein offener Redirect für beliebige Schemata
    if (!/^https?:\/\//i.test(target)) return reply.status(400).send('Ungültiges Ziel');
    logEmailEvent(req.params.id, 'click', req as any, target.slice(0, 500));
    reply.redirect(302, target);
  });

  // ── Analyse ───────────────────────────────────────────────────────────────
  app.get('/api/analytics/email', async () => {
    const db = getDb();
    const totals = db.prepare(
      `SELECT COUNT(*) as sent, SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as ok,
              SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failed
       FROM sent_emails`
    ).get() as { sent: number; ok: number; failed: number };

    const openedUnique = (db.prepare(
      `SELECT COUNT(DISTINCT sent_email_id) as n FROM email_events WHERE event_type = 'open'`
    ).get() as { n: number }).n;
    const clickedUnique = (db.prepare(
      `SELECT COUNT(DISTINCT sent_email_id) as n FROM email_events WHERE event_type = 'click'`
    ).get() as { n: number }).n;
    const bounced = (db.prepare(
      `SELECT COUNT(DISTINCT sent_email_id) as n FROM email_events WHERE event_type = 'bounce'`
    ).get() as { n: number }).n;

    // Öffnungen nach Uhrzeit (lokale Zeit, 0–23)
    const byHourRows = db.prepare(
      `SELECT CAST(strftime('%H', created_at, 'localtime') AS INTEGER) as h, COUNT(*) as n
       FROM email_events WHERE event_type = 'open' GROUP BY h`
    ).all() as Array<{ h: number; n: number }>;
    const opensByHour = Array.from({ length: 24 }, (_, h) => byHourRows.find(r => r.h === h)?.n ?? 0);

    // Versand + Öffnungen pro Tag, letzte 14 Tage
    const days: Array<{ day: string; sent: number; opened: number }> = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const day = d.toISOString().slice(0, 10);
      const sent = (db.prepare(
        `SELECT COUNT(*) as n FROM sent_emails WHERE success = 1 AND date(sent_at, 'localtime') = ?`
      ).get(day) as { n: number }).n;
      const opened = (db.prepare(
        `SELECT COUNT(DISTINCT sent_email_id) as n FROM email_events WHERE event_type = 'open' AND date(created_at, 'localtime') = ?`
      ).get(day) as { n: number }).n;
      days.push({ day, sent, opened });
    }

    // Einzelne Mails mit Tracking-Zusammenfassung
    const emails = db.prepare(
      `SELECT s.id, s.to_email, s.to_name, s.subject, s.success, s.error, s.sent_at, s.job_id,
              (SELECT COUNT(DISTINCT COALESCE(NULLIF(e.user_agent, ''), 'unknown') || '|' || COALESCE(NULLIF(e.ip, ''), 'unknown'))
                 FROM email_events e WHERE e.sent_email_id = s.id AND e.event_type = 'open') as opens,
              (SELECT COUNT(*) FROM email_events e WHERE e.sent_email_id = s.id AND e.event_type = 'open') as raw_opens,
              (SELECT MIN(created_at) FROM email_events e WHERE e.sent_email_id = s.id AND e.event_type = 'open') as first_open,
              (SELECT MAX(created_at) FROM email_events e WHERE e.sent_email_id = s.id AND e.event_type = 'open') as last_open,
              (SELECT COUNT(DISTINCT COALESCE(NULLIF(e.url, ''), 'unknown') || '|' || COALESCE(NULLIF(e.user_agent, ''), 'unknown') || '|' || COALESCE(NULLIF(e.ip, ''), 'unknown'))
                 FROM email_events e WHERE e.sent_email_id = s.id AND e.event_type = 'click') as clicks,
              (SELECT COUNT(*) FROM email_events e WHERE e.sent_email_id = s.id AND e.event_type = 'click') as raw_clicks,
              (SELECT COUNT(*) FROM email_events e WHERE e.sent_email_id = s.id AND e.event_type = 'bounce') as bounces,
              (SELECT COUNT(DISTINCT user_agent) FROM email_events e WHERE e.sent_email_id = s.id AND e.event_type = 'open') as devices
       FROM sent_emails s ORDER BY s.sent_at DESC LIMIT 150`
    ).all();

    const base = getTrackingBaseUrl();
    const isPublic = Boolean(base) && !/localhost|127\.0\.0\.1|192\.168\.|^$/.test(base);
    return {
      totals: { ...totals, opened: openedUnique, clicked: clickedUnique, bounced },
      open_rate: totals.ok > 0 ? Math.round(openedUnique / totals.ok * 100) : 0,
      click_rate: totals.ok > 0 ? Math.round(clickedUnique / totals.ok * 100) : 0,
      opens_by_hour: opensByHour,
      days,
      emails,
      tracking: { base_url: base || null, public: isPublic },
    };
  });

  app.get<{ Params: { id: string } }>('/api/analytics/email/:id/events', async (req) => {
    return getDb().prepare(
      `SELECT event_type, url, user_agent, created_at FROM email_events WHERE sent_email_id = ? ORDER BY created_at ASC`
    ).all(req.params.id);
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

  app.get('/api/analytics/sms', async () => getSmsStats());

  // Auto-Versand Worker starten
  startAutoSender();
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
