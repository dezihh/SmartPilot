import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from '../auth.js';
import { processQuery } from '../core/engine.js';
import { addLog, getSetting } from '../db.js';
export const queryRoutes = Router();

const handleQuery = async (req: Request, res: Response): Promise<void> => {
  const body = req.body as { sessionId?: string; userId?: string; text?: string };
  if (!body.text) {
    res.status(400).json({ error: 'text erforderlich' });
    return;
  }
  const result = await processQuery({
    sessionId: body.sessionId ?? 'api-test',
    userId: body.userId,
    text: body.text,
  });
  res.json(result);
};

queryRoutes.post('/api/query', requireAuth, handleQuery);
queryRoutes.post('/admin/api/query', requireAuth, handleQuery);

const handleLambdaTrace = (req: Request, res: Response) => {
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
queryRoutes.post('/api/lambda-trace', requireAuth, handleLambdaTrace);
queryRoutes.post('/admin/api/lambda-trace', requireAuth, handleLambdaTrace);
