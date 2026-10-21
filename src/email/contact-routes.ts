import { FastifyInstance } from 'fastify';
import { getDb } from '../db/schema';
import { checkAddress, discoverContact, normalizeAddress } from './contact-check';
import { classifyEmailDelivery } from './email-status';

function history(email: string) {
  const db = getDb();
  const last = db.prepare(`SELECT delivery_status, error, bounce_reason, sent_at, delivered_at
    FROM sent_emails WHERE LOWER(to_email) = ? ORDER BY sent_at DESC LIMIT 1`).get(email) as
    { delivery_status: string; error: string; bounce_reason: string; sent_at: string; delivered_at: string } | undefined;
  const suppressed = db.prepare('SELECT reason FROM email_suppression WHERE email_normalized = ?').get(email) as { reason: string } | undefined;
  return { suppressed: !!suppressed, suppressionReason: suppressed?.reason || null,
    lastDelivery: last ? { at: last.sent_at, status: last.delivery_status,
      label: classifyEmailDelivery({ deliveryStatus: last.delivery_status, error: last.error || last.bounce_reason }).label,
      reason: last.error || last.bounce_reason || null } : null };
}

export async function registerContactRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { email: string } }>('/api/email/address-check', {
    schema: { body: { type: 'object', required: ['email'], additionalProperties: false,
      properties: { email: { type: 'string', minLength: 1, maxLength: 254 } } } },
  }, async req => {
    const checked = await checkAddress(req.body.email);
    return { ...checked, ...history(normalizeAddress(req.body.email) || '') };
  });

  app.get<{ Params: { id: string }; Querystring: { name?: string } }>('/api/leads/:id/contact-suggestions', {
    schema: { querystring: { type: 'object', properties: { name: { type: 'string', maxLength: 100 } } } },
  }, async (req, reply) => {
    const lead = getDb().prepare('SELECT website, email, geschaeftsfuehrer FROM leads WHERE id = ?').get(req.params.id) as
      { website?: string; email?: string; geschaeftsfuehrer?: string } | undefined;
    if (!lead) return reply.status(404).send({ error: 'Lead nicht gefunden.' });
    const result = await discoverContact(lead, req.query.name);
    const domains = new Map<string, ReturnType<typeof checkAddress>>();
    for (const c of result.candidates) {
      const domain = c.email.split('@')[1];
      if (!domains.has(domain)) domains.set(domain, checkAddress(c.email));
    }
    return { ...result, candidates: await Promise.all(result.candidates.map(async c => ({
      ...c, check: { ...await domains.get(c.email.split('@')[1]), email: c.email }, ...history(c.email),
    }))) };
  });
}
