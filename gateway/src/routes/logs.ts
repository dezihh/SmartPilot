import { Router } from 'express';
import { requireAdminAuth } from '../auth.js';
import { listLogs, summarizeUsage } from '../db.js';

export const logsRoutes = Router();

logsRoutes.get('/admin/api/logs', requireAdminAuth, (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
  res.json({ logs: listLogs(limit) });
});

logsRoutes.get('/admin/api/usage', requireAdminAuth, (_req, res) => {
  res.json({ usage: summarizeUsage() });
});
