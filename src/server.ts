import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import { createHmac, timingSafeEqual } from 'crypto';
import { registerRoutes } from './approval/routes';

const AUTH_COOKIE_NAME = 'admin_auth';
const AUTH_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 12;

function getPathname(url: string): string {
  return url.split('?')[0] || '/';
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const cookies: Record<string, string> = {};
  for (const chunk of cookieHeader.split(';')) {
    const idx = chunk.indexOf('=');
    if (idx <= 0) continue;
    const name = chunk.slice(0, idx).trim();
    const value = chunk.slice(idx + 1).trim();
    if (!name) continue;
    cookies[name] = decodeURIComponent(value);
  }
  return cookies;
}

function makeAuthToken(adminPassword: string): string {
  return createHmac('sha256', adminPassword).update('tawano-admin-auth-v1').digest('hex');
}

function isCookieAuthorized(cookieHeader: string | undefined, adminPassword: string): boolean {
  const token = parseCookies(cookieHeader)[AUTH_COOKIE_NAME];
  if (!token) return false;
  const expected = makeAuthToken(adminPassword);
  const tokenBuf = Buffer.from(token);
  const expectedBuf = Buffer.from(expected);
  if (tokenBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(tokenBuf, expectedBuf);
}

function cookieHeaderValue(value: string, secure: boolean, maxAgeSeconds: number): string {
  const parts = [
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function shouldBypassAuth(pathname: string): boolean {
  if (pathname === '/login') return true;
  if (pathname === '/health') return true;
  if (pathname === '/track.js') return true;
  if (pathname.startsWith('/track/open/')) return true;
  if (pathname.startsWith('/track/click/')) return true;
  if (pathname.startsWith('/track/sms/')) return true;
  if (pathname.startsWith('/unsubscribe/')) return true;
  if (pathname.startsWith('/webhook/')) return true;
  // Legacy tracking endpoints used by old emails.
  if (pathname.startsWith('/t/o/')) return true;
  if (pathname.startsWith('/t/c/')) return true;
  return false;
}

function buildLoginHtml(errorMessage?: string): string {
  const error = errorMessage ? `<p style="color:#c62828;margin:0 0 14px">${errorMessage}</p>` : '';
  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin Login</title>
  <style>
    body { font-family: Arial, sans-serif; background: #f4f6fb; margin: 0; min-height: 100vh; display: grid; place-items: center; }
    .card { width: min(92vw, 360px); background: #fff; border: 1px solid #d8deea; border-radius: 12px; padding: 22px; box-shadow: 0 10px 30px rgba(14,24,39,.08); }
    h1 { margin: 0 0 14px; font-size: 20px; color: #12223a; }
    p { margin: 0 0 14px; color: #4a5a74; font-size: 14px; }
    label { display: block; margin-bottom: 6px; font-size: 13px; color: #22344f; font-weight: 600; }
    input { width: 100%; box-sizing: border-box; border: 1px solid #c7d1e2; border-radius: 8px; padding: 11px; font-size: 14px; }
    input:focus { outline: none; border-color: #2e6ee8; box-shadow: 0 0 0 3px rgba(46,110,232,.14); }
    button { margin-top: 14px; width: 100%; border: 0; border-radius: 8px; padding: 11px; background: #1d5ad0; color: #fff; font-size: 14px; font-weight: 700; cursor: pointer; }
    button:hover { background: #1748aa; }
  </style>
</head>
<body>
  <main class="card">
    <h1>Admin Login</h1>
    <p>Bitte Admin-Passwort eingeben.</p>
    ${error}
    <form method="post" action="/login">
      <label for="password">Passwort</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required />
      <button type="submit">Einloggen</button>
    </form>
  </main>
</body>
</html>`;
}

export async function buildServer() {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true });
  await app.register(formbody);

  app.addHook('onRequest', async (req, reply) => {
    const pathname = getPathname(req.url);
    if (shouldBypassAuth(pathname)) return;

    const adminPassword = (process.env.ADMIN_PASSWORD || '').trim();
    if (!adminPassword) {
      return reply.status(503).send({ error: 'ADMIN_PASSWORD ist nicht gesetzt' });
    }

    const authorized = isCookieAuthorized(req.headers.cookie, adminPassword);
    if (authorized) return;

    const redirectTo = encodeURIComponent(req.url || '/');
    return reply.redirect(302, `/login?next=${redirectTo}`);
  });

  app.get<{ Querystring: { next?: string } }>('/login', async (req, reply) => {
    const adminPassword = (process.env.ADMIN_PASSWORD || '').trim();
    if (!adminPassword) {
      return reply.status(503).type('text/html').send(buildLoginHtml('ADMIN_PASSWORD fehlt auf dem Server.'));
    }
    if (isCookieAuthorized(req.headers.cookie, adminPassword)) {
      const next = typeof req.query.next === 'string' && req.query.next.startsWith('/') ? req.query.next : '/';
      return reply.redirect(302, next);
    }
    return reply.type('text/html').send(buildLoginHtml());
  });

  app.post<{ Body: { password?: string }; Querystring: { next?: string } }>('/login', async (req, reply) => {
    const adminPassword = (process.env.ADMIN_PASSWORD || '').trim();
    if (!adminPassword) {
      return reply.status(503).type('text/html').send(buildLoginHtml('ADMIN_PASSWORD fehlt auf dem Server.'));
    }

    const submittedPassword = (req.body?.password || '').toString();
    if (submittedPassword !== adminPassword) {
      return reply.status(401).type('text/html').send(buildLoginHtml('Falsches Passwort.'));
    }

    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').toLowerCase();
    const secureCookie = forwardedProto === 'https' || process.env.NODE_ENV === 'production';
    reply.header('Set-Cookie', cookieHeaderValue(makeAuthToken(adminPassword), secureCookie, AUTH_COOKIE_MAX_AGE_SECONDS));

    const next = typeof req.query.next === 'string' && req.query.next.startsWith('/') ? req.query.next : '/';
    return reply.redirect(302, next);
  });

  app.post('/logout', async (req, reply) => {
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').toLowerCase();
    const secureCookie = forwardedProto === 'https' || process.env.NODE_ENV === 'production';
    reply.header('Set-Cookie', cookieHeaderValue('', secureCookie, 0));
    return reply.redirect(302, '/login');
  });

  await registerRoutes(app);

  app.get('/health', async () => ({ ok: true }));
  app.get('/leadgen', async (_req, reply) => reply.redirect('/'));

  return app;
}

export async function main() {
  const app = await buildServer();
  const port = Number(process.env.PORT) || 4000;
  await app.listen({
    port,
    host: '0.0.0.0',
  });
  console.log(`Tawano Lead-Gen Dashboard: http://0.0.0.0:${port}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
