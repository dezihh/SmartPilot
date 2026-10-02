import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireApiAuth } from '../auth.js';
import { checkRateLimit } from '../rateLimit.js';
import { config } from '../config.js';
import { processQuery } from '../core/engine.js';
import { addLog, getSetting } from '../db.js';
export const queryRoutes = Router();

export const handleQuery = async (req: Request, res: Response): Promise<void> => {
  const body = req.body as { sessionId?: string; userId?: string; text?: string };
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) {
    res.status(400).json({ error: 'text erforderlich' });
    return;
  }
  if (text.length > config.queryMaxChars) {
    res.status(413).json({ error: `text zu lang (max. ${config.queryMaxChars} Zeichen)` });
    return;
  }
  // Header X-Alexa-Skill-Id ist NICHT vertrauenswuerdig (frei setzbar, wer das
  // API_TOKEN hat) - reine Log-Info, keine Sicherheitsgrenze. Die autoritative
  // applicationId-Pruefung macht die Lambda (sb.skill_id). Hier nur Warnung.
  const skillId = String(req.headers['x-alexa-skill-id'] ?? '').slice(0, 120);
  if (skillId && config.alexaSkillId && skillId !== config.alexaSkillId) {
    console.warn('[query] Skill-ID-Mismatch: Header=%s erwartet=%s', skillId, config.alexaSkillId);
  }
  // Key: bevorzugt userId, sonst Client-IP (mit 'trust proxy' korrekt).
  const key = body.userId ? `query:u:${body.userId}` : `query:ip:${req.ip ?? 'unbekannt'}`;
  if (!checkRateLimit(key, Date.now(), 60_000, config.queryRateMax)) {
    res.status(429).json({ error: 'zu viele Anfragen, spaeter erneut' });
    return;
  }
  const result = await processQuery({
    sessionId: body.sessionId ?? 'api-test',
    userId: body.userId,
    text,
  });
  res.json(result);
};

queryRoutes.post('/api/query', requireApiAuth, handleQuery);

export const handleLambdaTrace = (req: Request, res: Response) => {
  const body = req.body as { sessionId?: string; event?: string; elapsedMs?: number; note?: string };
  if (getSetting('debug_logging') === '1') {
    // Felder whitelisten und begrenzen: kein kompletter Request-Body (PII).
    const event = String(body.event ?? '?').slice(0, 40);
    const note = String(body.note ?? '').slice(0, 200);
    addLog({
      sessionId: String(body.sessionId ?? 'lambda').slice(0, 120),
      query: `event=${event}${note ? ` note=${note}` : ''}`,
      route: `lambda-trace:${event}`,
      response: '',
      durationMs: Number.isFinite(Number(body.elapsedMs)) ? Number(body.elapsedMs) : 0,
      trace: [],
    });
  }
  res.status(204).end();
};
// Unter /api (nicht /admin): die LAN-only-Regel des Nginx-Vhosts blockiert sonst AWS-Lambda-IPs (403).
// Der Admin-Alias (/admin/api/lambda-trace) wird in app.ts unter dem Admin-Prefix registriert.
queryRoutes.post('/api/lambda-trace', requireApiAuth, handleLambdaTrace);
