import { Router } from 'express';
import { requireAdminAuth } from '../auth.js';
import { errMsg, parseId } from './helpers.js';
import {
  createHttpConnection,
  deleteHttpConnection,
  getHttpConnection,
  listHttpConnections,
  maskHttpConnectionSecrets,
  updateHttpConnection,
} from '../db.js';
import { normalizeHttpConnectionInput } from '../core/httpConnections.js';

export const httpConnectionsRoutes = Router();

httpConnectionsRoutes.get('/admin/api/http-connections', requireAdminAuth, (_req, res) => {
  res.json({ connections: listHttpConnections(false) });
});

httpConnectionsRoutes.post('/admin/api/http-connections', requireAdminAuth, (req, res) => {
  try {
    const created = createHttpConnection(normalizeHttpConnectionInput(req.body as Record<string, unknown>));
    res.json({ connection: maskHttpConnectionSecrets(created) });
  } catch (e) {
    res.status(400).json({ error: errMsg(e) });
  }
});

httpConnectionsRoutes.put('/admin/api/http-connections/:id', requireAdminAuth, (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: 'ungueltige ID' });
    return;
  }
  const body = req.body as Record<string, unknown>;
  try {
    const updated = updateHttpConnection(id, normalizeHttpConnectionInput(body), headersCleared(body.headers));
    if (!updated) {
      res.status(404).json({ error: 'nicht gefunden' });
      return;
    }
    res.json({ connection: maskHttpConnectionSecrets(updated) });
  } catch (e) {
    res.status(400).json({ error: errMsg(e) });
  }
});

httpConnectionsRoutes.delete('/admin/api/http-connections/:id', requireAdminAuth, (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: 'ungueltige ID' });
    return;
  }
  if (!getHttpConnection(id)) {
    res.status(404).json({ error: 'nicht gefunden' });
    return;
  }
  deleteHttpConnection(id);
  res.json({ ok: true });
});

// {} ist die ausdrueckliche Loeschung; null/leer/maskiert behaelt den Wert.
function headersCleared(input: unknown): boolean {
  if (input == null) return false;
  if (typeof input === 'string') return input.trim() === '{}';
  return typeof input === 'object' && !Array.isArray(input) && Object.keys(input as Record<string, unknown>).length === 0;
}
