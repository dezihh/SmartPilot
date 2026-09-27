import express, { type Express } from 'express';
import { join } from 'node:path';
import { createSession, sessionValid, cookieFor } from './auth.js';
import { checkRateLimit } from './rateLimit.js';
import { queryRoutes } from './routes/query.js';
import { adminRoutes } from './routes/admin.js';
import { mcpRoutes } from './routes/mcp.js';
import { packagesRoutes } from './routes/packages.js';

// Baut die Express-App (ohne listen), damit Routen/Tests sie direkt nutzen
// koennen. Der Entry src/server.ts startet sie nur.
export function createApp(): Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Feature-Routen (je eine Datei in src/routes/)
  app.use(queryRoutes);
  app.use(adminRoutes);
  app.use(mcpRoutes);
  app.use(packagesRoutes);

  // Admin-UI-Login: Token pruefen, Session-Cookie setzen (rate-limited gegen Brute-Force)
  app.post('/admin/login', (req, res) => {
    if (!checkRateLimit(req.ip ?? 'unbekannt')) {
      res.status(429).json({ error: 'zu viele Versuche, spaeter erneut' });
      return;
    }
    const header = req.headers.authorization ?? '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
    const token = bearer || String((req.body as { token?: unknown })?.token ?? '');
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
  app.get('/admin/login.html', (_req, res) => {
    res.sendFile(join(process.cwd(), 'web', 'login.html'));
  });

  // Statische Admin-UI nur mit gueltiger Session (Login-Cookie oder Bearer-Query)
  app.use('/admin', (req, res, next) => {
    if (!sessionValid(req)) {
      if (req.headers.accept?.includes('text/html')) {
        res.redirect('/admin/login.html');
        return;
      }
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  });
  app.use('/admin', express.static(join(process.cwd(), 'web')));

  return app;
}
