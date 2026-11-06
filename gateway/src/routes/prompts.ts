import { Router } from 'express';
import { requireAdminAuth } from '../auth.js';
import { setPrompt } from '../db.js';

export const promptsRoutes = Router();

promptsRoutes.put('/admin/api/prompts/:key', requireAdminAuth, (req, res) => {
  const body = req.body as { content?: string };
  if (typeof body.content !== 'string') {
    res.status(400).json({ error: 'content erforderlich' });
    return;
  }
  setPrompt(String(req.params.key), body.content);
  res.json({ ok: true });
});
