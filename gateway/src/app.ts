import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  createSession,
  requestAuthorized,
  bearerToken,
  cookieFor,
  requireAdminAuth,
  type RequestWithRawBody,
} from './auth.js';
import { checkRateLimit } from './rateLimit.js';
import { config } from './config.js';
import { getSchemaVersion, getDb } from './db.js';
import { queryRoutes, handleQuery, handleLambdaTrace } from './routes/query.js';
import { adminRoutes } from './routes/admin.js';
import { mcpServersRoutes } from './routes/mcpServers.js';
import { promptsRoutes } from './routes/prompts.js';
import { logsRoutes } from './routes/logs.js';
import { packagesRoutes } from './routes/packages.js';
import { runWithRequestId, log, logError } from './core/logger.js';
import { incCounter, setGauge, renderMetrics } from './core/metrics.js';

// Baut die Express-App (ohne listen), damit Routen/Tests sie direkt nutzen
// koennen. Der Entry src/server.ts startet sie nur.
export function createApp(): Express {
  const app = express();
  // Hinter einem Reverse-Proxy die echte Client-IP aus X-Forwarded-For lesen
  // (sonst greift das Rate-Limit fuer alle Clients gemeinsam auf die Proxy-IP).
  if (config.trustProxy !== undefined) app.set('trust proxy', config.trustProxy);

  // Anfrage-Kennung: uebernommene X-Request-ID (nur im erwarteten Zeichen-
  // satz) oder eine neue UUID. Sie steht im Antwortheader und in jeder
  // Logzeile dieses Requests, damit Proxy-Log und Gateway-Log zusammenfinden.
  app.use((req, res, next) => {
    const incoming = String(req.headers['x-request-id'] ?? '').trim();
    const requestId = /^[A-Za-z0-9._-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Request-ID', requestId);
    const startedAt = Date.now();
    // Healthchecks laufen alle 30 s - nur auf debug protokollieren.
    const level = req.path === '/healthz' ? 'debug' : 'info';
    let logged = false;
    res.on('finish', () => {
      logged = true;
      const ms = Date.now() - startedAt;
      log[level]('http', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms,
      });
      // Route statt Pfad als Label: dynamische IDs wuerden die Anzahl der
      // Zeitreihen unbegrenzt wachsen lassen.
      const route = req.route?.path ?? 'unmatched';
      const status = String(res.statusCode);
      incCounter('smartpilot_http_requests_total', { status, route }, 'HTTP-Anfragen je Status und Route');
      incCounter('smartpilot_http_request_duration_seconds_sum', {}, 'Summe der Antwortzeiten in Sekunden', ms / 1000);
      incCounter('smartpilot_http_request_duration_seconds_count', {}, 'Anzahl gemessener Antwortzeiten');
    });
    res.on('close', () => {
      if (logged) return;
      log.warn('http abgebrochen', { method: req.method, path: req.path, ms: Date.now() - startedAt });
    });
    runWithRequestId(requestId, next);
  });
  // Sicherheits-Header: Die Admin-UI laedt ausschliesslich eigene Module und
  // spricht nur mit der eigenen Origin. Kein Inline-Skript, keine externen
  // Quellen. Der Proxy darf eigene Header (HSTS) zusaetzlich setzen.
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'"
    );
    next();
  });
  // Restore traegt die komplette Konfiguration im Body; das globale 1-MB-Limit
  // wuerde groessere Sicherungen (Prompts/Manifeste) mit 413 abweisen.
  app.use(`${config.basePath}/admin/api/backup/restore`, express.json({ limit: '25mb' }));
  // Roh-Body fuer die HMAC-Pruefung der Adapter-API aufbewahren (Replay-Schutz,
  // Issue #5). Ohne dieses Byte-Original waere die Signatur nicht nachrechenbar,
  // weil der Parser den Body neu serialisiert.
  const captureRawBody = (req: Request, _res: Response, buf: Buffer): void => {
    (req as RequestWithRawBody).rawBody = buf;
  };
  app.use(express.json({ limit: '1mb', verify: captureRawBody }));

  // Liveness fuer den Container-Healthcheck (keine Geheimnisse, keine Auth).
  app.get('/healthz', (_req, res) => {
    try {
      const schemaVersion = getSchemaVersion();
      // Schreibfaehigkeit pruefen, ohne Daten zu veraendern (WAL/Read-only-FS).
      const db = getDb();
      db.exec('BEGIN IMMEDIATE');
      db.exec('ROLLBACK');
      res.json({ ok: true, schema_version: schemaVersion });
    } catch {
      // DB nicht erreichbar oder nicht schreibbar -> Container ist nicht gesund.
      res.status(503).json({ ok: false, error: 'db nicht erreichbar' });
    }
  });

  const base = config.basePath; // '' = Wurzel, sonst '/prefix' ohne Trailing-Slash
  const adminBase = `${base}/admin`;

  // Auch fehlgeschlagene Admin-Token-Versuche zaehlen (Brute-Force). Das Limit
  // ist bewusst grosszuegig, damit die UI im Normalbetrieb nicht ausgesperrt wird.
  // `/metrics` haengt am selben Limiter, aber unter eigenem Schluessel, damit
  // Prometheus-Scrapes nicht das Admin-UI-Budget verbrauchen (F-010).
  const adminLimiter =
    (prefix: string) => (req: Request, res: Response, next: NextFunction) => {
      const key = `${prefix}:ip:${req.ip ?? 'unbekannt'}`;
      if (!checkRateLimit(key, Date.now(), 60_000, config.adminRateMax)) {
        res.status(429).json({ error: 'zu viele Anfragen, spaeter erneut' });
        return;
      }
      next();
    };

  // Metriken im Prometheus-Format. Nur mit Admin-Token/Cookie, weil die
  // Zeitreihen Routen und Fehlerraten des Gateways offenlegen.
  app.get('/metrics', adminLimiter('metrics'), requireAdminAuth, (_req, res) => {
    setGauge('smartpilot_uptime_seconds', Math.round(process.uptime()), {}, 'Laufzeit des Prozesses');
    setGauge('smartpilot_resident_memory_bytes', process.memoryUsage().rss, {}, 'Resident-Speicher des Prozesses');
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(renderMetrics());
  });

  app.use(`${adminBase}/api`, adminLimiter('admin'));

  // Oeffentliche Adapter-API bleibt auf der Wurzel (Lambda/Alexa): /api/query,
  // /api/lambda-trace. Der Prefix gilt nur fuer die Admin-UI .
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

  // Login-Seite samt Assets ist ohne Session erreichbar (legt das Cookie).
  admin.get('/admin/login.html', (_req, res) => {
    res.sendFile(join(process.cwd(), 'web', 'login.html'));
  });
  admin.get('/admin/css/login.css', (_req, res) => {
    res.sendFile(join(process.cwd(), 'web', 'css', 'login.css'));
  });
  admin.get('/admin/js/login.js', (_req, res) => {
    res.sendFile(join(process.cwd(), 'web', 'js', 'login.js'));
  });

  // Statische Admin-UI: Bearer-Token ODER Session-Cookie. Ein vorgelagerter
  // Proxy kann so die UI ohne App-Login bedienen ; das Token bleibt
  // proxy-seitig und gelangt nie in den Browser. Die drei Login-Dateien sind
  // bereits oben als eigene Routen oeffentlich; eine zusaetzliche Pfadliste
  // hier waere toter Code (F-005).
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

  // Trailing-Slash erzwingen (erst NACH Auth): sonst loesen relative Asset-/
  // API-Pfade im Frontend gegen das falsche Verzeichnis auf. Exakter
  // Pfadvergleich (Express matcht '/admin' sonst auch auf '/admin/'); Query
  // bleibt erhalten.
  admin.use((req, res, next) => {
    if (req.path === '/admin') {
      const query = req.originalUrl.includes('?')
        ? req.originalUrl.slice(req.originalUrl.indexOf('?'))
        : '';
      res.redirect(`${adminBase}/${query}`);
      return;
    }
    next();
  });
  admin.use('/admin', express.static(join(process.cwd(), 'web')));

  // Admin-API-Routen (Pfade sind relativ zum Mount, z. B. '/admin/api/...')
  admin.use(adminRoutes);
  admin.use(mcpServersRoutes);
  admin.use(promptsRoutes);
  admin.use(logsRoutes);
  admin.use(packagesRoutes);
  // Admin-Aliase der Adapter-API - unter dem Prefix statt auf der Wurzel.
  admin.post('/admin/api/query', requireAdminAuth, handleQuery);
  admin.post('/admin/api/lambda-trace', requireAdminAuth, handleLambdaTrace);

  app.use(base || '/', admin);

  // Zentraler JSON-Fehlerhandler: Parser-Fehler (kaputtes JSON, zu grosser
  // Body) sollen nicht die Express-HTML-Seite ausliefern.
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const status = Number((err as { status?: number }).status) || 500;
    const tooLarge = (err as { type?: string }).type === 'entity.too.large';
    if (status >= 500) logError('Anfrage fehlgeschlagen', err, { path: req.path, status });
    res
      .status(status)
      .json({ error: tooLarge ? 'Anfrage zu gross' : status < 500 ? 'Ungueltige Anfrage' : 'Interner Fehler' });
  });

  return app;
}
