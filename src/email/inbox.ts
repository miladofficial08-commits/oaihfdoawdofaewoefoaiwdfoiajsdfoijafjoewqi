import { ImapFlow } from 'imapflow';

export interface InboxEmail {
  uid: number;
  seq: number;
  from: string;
  fromName: string;
  subject: string;
  date: string;
  snippet: string;
  body: string;
  seen: boolean;
  inReplyTo?: string;
}

export interface ImapConnectionStatus {
  ok: boolean;
  configured: boolean;
  host?: string;
  total?: number;
  unseen?: number;
  error?: string;
}

function getImapCfg() {
  const smtpHost = process.env.SMTP_HOST || '';
  const derivedHost = smtpHost.replace(/^smtps?\./i, 'imap.');
  return {
    host: process.env.IMAP_HOST || derivedHost || 'imap.udag.de',
    port: Number(process.env.IMAP_PORT || 993),
    secure: process.env.IMAP_SECURE_SSL !== 'false',
    user: process.env.IMAP_USER || process.env.SMTP_USER || '',
    pass: process.env.IMAP_PASS || process.env.SMTP_PASS || '',
  };
}

function mkClient(cfg: ReturnType<typeof getImapCfg>) {
  return new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
    tls: { rejectUnauthorized: false },
    connectionTimeout: 10000,
    greetingTimeout: 8000,
  } as any);
}

export async function getImapStatus(): Promise<ImapConnectionStatus> {
  const cfg = getImapCfg();
  if (!cfg.user || !cfg.pass) return { ok: false, configured: false, error: 'IMAP_USER / IMAP_PASS fehlen' };
  const client = mkClient(cfg);
  try {
    await client.connect();
    const st = await client.status('INBOX', { messages: true, unseen: true });
    await client.logout();
    return { ok: true, configured: true, host: cfg.host, total: st.messages || 0, unseen: st.unseen || 0 };
  } catch (err) {
    return { ok: false, configured: true, host: cfg.host, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function fetchInboxEmails(limit = 40): Promise<InboxEmail[]> {
  const cfg = getImapCfg();
  if (!cfg.user || !cfg.pass || !cfg.host) return [];
  const client = mkClient(cfg);
  const emails: InboxEmail[] = [];
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const st = await client.status('INBOX', { messages: true });
      const total = st.messages || 0;
      if (!total) return [];
      const start = Math.max(1, total - limit + 1);
      for await (const msg of client.fetch(`${start}:*`, {
        uid: true,
        envelope: true,
        flags: true,
        bodyParts: ['1', 'TEXT'],
      } as any)) {
        const env = msg.envelope;
        const fromAddr = env?.from?.[0];
        const bodyBuf = (msg as any).bodyParts?.get('1') || (msg as any).bodyParts?.get('TEXT');
        const raw = bodyBuf ? Buffer.from(bodyBuf).toString('utf-8') : '';
        const clean = raw
          .split('\n').filter(l => !l.startsWith('>') && !l.match(/^-{3,}/) && !l.match(/^_{3,}/))
          .join('\n').replace(/\s+/g, ' ').trim();
        emails.push({
          uid: msg.uid,
          seq: msg.seq,
          from: fromAddr?.address || '',
          fromName: fromAddr?.name || fromAddr?.address || 'Unbekannt',
          subject: env?.subject || '(kein Betreff)',
          date: env?.date?.toISOString() || new Date().toISOString(),
          snippet: clean.slice(0, 180),
          body: clean.slice(0, 4000),
          seen: msg.flags?.has('\\Seen') ?? false,
          inReplyTo: env?.inReplyTo || undefined,
        });
      }
    } finally {
      lock.release();
    }
    return emails.reverse();
  } finally {
    await client.logout().catch(() => {});
  }
}

export async function markEmailSeen(uid: number): Promise<void> {
  const cfg = getImapCfg();
  if (!cfg.user || !cfg.pass) return;
  const client = mkClient(cfg);
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      await client.messageFlagsAdd({ uid: [uid] } as any, ['\\Seen'], { uid: true } as any);
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}
