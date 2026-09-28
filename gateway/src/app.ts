import express, { type Express } from 'express';
import { join } from 'node:path';
import { createSession, requestAuthorized, bearerToken, cookieFor, requireAuth } from './auth.js';
import { checkRateLimit } from './rateLimit.js';
import { config } from './config.js';
import { queryRoutes, handleQuery, handleLambdaTrace } from './routes/query.js';
import { adminRoutes } from './routes/admin.js';
import { mcpRoutes } from './routes/mcp.js';
import { packagesRoutes } from './routes/packages.js';

// Baut die Express-App (ohne listen), damit Routen/Tests sie direkt nutzen
// koennen. Der Entry src/server.ts startet sie nur.
export function createApp(): Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const base = config.basePath; // '' = Wurzel, sonst '/prefix' ohne Trailing-Slash
  const adminBase = `${base}/admin`;

  // Oeffentliche Adapter-API bleibt auf der Wurzel (Lambda/Alexa): /api/query,
  // /api/lambda-trace. Der Prefix gilt nur fuer die Admin-UI (Issue #10).
  app.use(queryRoutes);

  // Admin-Bereich - optional unter BASE_PATH (Sub-URL hinter einem Reverse-Proxy,
  // ohne Pfad-Rewrites im Proxy).
  const admin = express.Router();

  // Admin-UI-Login: Token pruefen, Session-Cookie setzen (rate-limited gegen Brute-Force)
  admin.post('/admin/login', (req, res) => {
    if (!checkRateLimit(req.ip ?? 'unbekannt')) {
      res.status(429).json({ error: 'zu viele Versuche, spaeter erneut' });
      return;
    }
    const token = bearerToken(req) || String((req.body as { token?: unknown })?.token ?? '');
    const sessionId = createSession(token);
    if (!sessionId) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    // Secure-Flag nur hinter TLS (Reverse-Proxy meldet X-Forwarded-Proto).
    // Direkter LAN-Zugriff ueber HTTP braucht das Cookie ohne Secure.
    const secure = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]!.trim() === 'https';
    res.setHeader('Set-Cookie', cookieFor(sessionId, secure));
    // Session-ID nicht im Body spiegeln (kein JS-Zugriff noetig; die HttpOnly-
    // Cookie authentifiziert). Verhindert, dass ein XSS sie auslesen koennte.
    res.json({ ok: true });
  });

  // Login-Seite ist ohne Session erreichbar (legt das Cookie)
  admin.get('/admin/login.html', (_req, res) => {
    res.sendFile(join(process.cwd(), 'web', 'login.html'));
  });

  // Trailing-Slash erzwingen: sonst loesen relative Asset-/API-Pfade im Frontend
  // gegen das falsche Verzeichnis auf. Exakter Pfadvergleich (Express matcht
  // '/admin' sonst auch auf '/admin/').
  admin.use((req, res, next) => {
    if (req.path === '/admin') {
      res.redirect(`${adminBase}/`);
      return;
    }
    next();
  });

  // Statische Admin-UI: Bearer-Token ODER Session-Cookie. Ein vorgelagerter
  // Proxy kann so die UI ohne App-Login bedienen (Issue #10); das Token bleibt
  // proxy-seitig und gelangt nie in den Browser.
  admin.use('/admin', (req, res, next) => {
    if (!requestAuthorized(req)) {
      if (req.headers.accept?.includes('text/html')) {
        res.redirect(`${adminBase}/login.html`);
        return;
      }
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  });
  admin.use('/admin', express.static(join(process.cwd(), 'web')));

  // Admin-API-Routen (Pfade sind relativ zum Mount, z. B. '/admin/api/...')
  admin.use(adminRoutes);
  admin.use(mcpRoutes);
  admin.use(packagesRoutes);
  // Admin-Aliase der Adapter-API - unter dem Prefix statt auf der Wurzel.
  admin.post('/admin/api/query', requireAuth, handleQuery);
  admin.post('/admin/api/lambda-trace', requireAuth, handleLambdaTrace);

  app.use(base || '/', admin);

  return app;
}
