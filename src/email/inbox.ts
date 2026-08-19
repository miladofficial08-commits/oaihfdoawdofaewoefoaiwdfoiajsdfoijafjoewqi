import { ImapFlow } from 'imapflow';
import { isNoise } from './noise-filter';

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
        headers: ['auto-submitted', 'x-autoreply', 'x-autorespond', 'precedence', 'list-unsubscribe', 'list-id'],
        bodyParts: ['1', 'TEXT'],
      } as any)) {
        const env = msg.envelope;
        const fromAddr = env?.from?.[0];
        const headersBuf = (msg as any).headers;
        const headers = headersBuf ? Buffer.from(headersBuf).toString('utf-8') : '';
        // Rausch-Mails (Bounces, Auto-Reply, „Verifica profilo", Newsletter, System-Noise)
        // gar nicht erst ins UI schleusen.
        if (isNoise({
          fromEmail: fromAddr?.address || '',
          fromName: fromAddr?.name || '',
          subject: env?.subject || '',
          headers,
        })) continue;
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

/**
 * Löscht Rausch-Mails (Bounces, Auto-Reply, „Verifica"-Challenges, Newsletter,
 * System-Noise, eigene Loops) direkt aus dem IMAP-Posteingang. Läuft periodisch
 * mit dem Reply-Scan (siehe reply-scanner.ts), damit der Posteingang sauber bleibt.
 * Gibt zurück, wie viele UIDs gelöscht wurden.
 */
export async function purgeInboxNoise(scanLimit = 200): Promise<{ deleted: number; scanned: number }> {
  const cfg = getImapCfg();
  if (!cfg.user || !cfg.pass || !cfg.host) return { deleted: 0, scanned: 0 };
  const client = mkClient(cfg);
  let scanned = 0;
  const noiseUids: number[] = [];
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const st = await client.status('INBOX', { messages: true });
      const total = st.messages || 0;
      if (!total) return { deleted: 0, scanned: 0 };
      const start = Math.max(1, total - scanLimit + 1);
      for await (const msg of client.fetch(`${start}:*`, {
        uid: true,
        envelope: true,
        headers: ['auto-submitted', 'x-autoreply', 'x-autorespond', 'precedence', 'list-unsubscribe', 'list-id'],
      } as any)) {
        scanned++;
        const env = (msg as any).envelope || {};
        const fromAddr = env.from?.[0] || {};
        const headersBuf = (msg as any).headers;
        const headers = headersBuf ? Buffer.from(headersBuf).toString('utf-8') : '';
        if (isNoise({
          fromEmail: fromAddr.address || '',
          fromName: fromAddr.name || '',
          subject: env.subject || '',
          headers,
        })) noiseUids.push(msg.uid);
      }
      if (noiseUids.length) await client.messageDelete(noiseUids, { uid: true } as any);
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return { deleted: noiseUids.length, scanned };
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
