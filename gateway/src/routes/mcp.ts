import { Router } from 'express';
import { join } from 'node:path';
import { requireAuth, createSession, sessionValid, cookieFor } from '../auth.js';
import { config } from '../config.js';
import {
  deleteMcpServer,
  createMcpServer,
  getMcpServer,
  listFunctions,
  listLogs,
  listMcpServers,
  setPrompt,
  summarizeUsage,
  updateMcpServer,
  type McpServerInput,
} from '../db.js';
import { createClient, getMcpContext, invalidateMcpCache } from '../mcp/registry.js';
export const mcpRoutes = Router();

function normalizeServerInput(body: Record<string, unknown>): McpServerInput {
  const name = String(body.name ?? '').trim();
  const transport = body.transport === 'stdio' ? 'stdio' : 'http';
  let url = String(body.url ?? '').trim();
  let command: string | null = null;
  let args: string | null = null;
  let env: string | null = null;
  if (transport === 'stdio') {
    command = String(body.command ?? '').trim();
    if (!command) throw new Error('command ist für Transport stdio erforderlich');
    if (!name) throw new Error('name ist erforderlich');
    url = '';
    const argsList = Array.isArray(body.args)
      ? (body.args as unknown[]).map(String)
      : String(body.args ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
    args = JSON.stringify(argsList);
    const envRaw = body.env;
    if (envRaw === undefined || envRaw === null || envRaw === '') {
      // Nicht ueberschreiben (COALESCE): die Admin-UI zeigt maskierte env nicht
      // an, ein leeres Feld darf die bestehenden Secrets nicht wischen (F-34).
      env = null;
    } else {
      const envObj: Record<string, string> = {};
      const entries: [string, string][] =
        typeof envRaw === 'object' && !Array.isArray(envRaw)
          ? Object.entries(envRaw as Record<string, unknown>).map(([k, v]) => [k, String(v)])
          : String(envRaw)
              .split('\n')
              .map((line) => {
                const i = line.indexOf('=');
                return i > 0 ? ([line.slice(0, i).trim(), line.slice(i + 1).trim()] as [string, string]) : null;
              })
              .filter((e): e is [string, string] => e !== null);
      for (const [k, v] of entries) if (k) envObj[k] = v;
      env = JSON.stringify(envObj);
    }
  } else if (!url || !name) {
    throw new Error('name und url sind erforderlich');
  }
  return {
    name,
    url,
    auth_token: body.auth_token ? String(body.auth_token) : null,
    transport,
    command,
    args,
    env,
    inventory_prompt: body.inventory_prompt == null ? null : String(body.inventory_prompt).trim() || null,
    side_effect: body.side_effect === 'read' ? 'read' : 'write',
    enabled: body.enabled === false || body.enabled === 0 || body.enabled === '0' || body.enabled === 'false' ? 0 : 1,
  };
}

mcpRoutes.get('/admin/api/mcp-servers', requireAuth, (req, res) => {
  res.json({ servers: listMcpServers(false) });
});

// Alle fuer LLM-Actions verfuegbaren Tools (Facade + MCP) fuer den Web-Editor
mcpRoutes.get('/admin/api/tools', requireAuth, async (req, res) => {
  try {
    const mcp = await getMcpContext();
    const serverTools = mcp.servers.map((s) => ({ server: s.name, tools: s.tools.map((t) => t.name) }));
    const functions = listFunctions(true).map((f) => `fn_${f.name}`);
    res.json({ mcp: serverTools, functions });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

mcpRoutes.post('/admin/api/mcp-servers', requireAuth, (req, res) => {
  try {
    const server = createMcpServer(normalizeServerInput(req.body as Record<string, unknown>));
    invalidateMcpCache();
    res.json({ server });
  } catch (e) {
    res.status(400).json({ error: String(e instanceof Error ? e.message : e) });
  }
});

mcpRoutes.put('/admin/api/mcp-servers/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  try {
    const updated = updateMcpServer(id, normalizeServerInput(req.body as Record<string, unknown>));
    invalidateMcpCache();
    if (!updated) {
      res.status(404).json({ error: 'nicht gefunden' });
      return;
    }
    res.json({ server: updated });
  } catch (e) {
    res.status(400).json({ error: String(e instanceof Error ? e.message : e) });
  }
});

mcpRoutes.delete('/admin/api/mcp-servers/:id', requireAuth, (req, res) => {
  deleteMcpServer(Number(req.params.id));
  invalidateMcpCache();
  res.json({ ok: true });
});

mcpRoutes.post('/admin/api/mcp-servers/:id/health', requireAuth, async (req, res) => {
  const server = getMcpServer(Number(req.params.id));
  if (!server) {
    res.status(404).json({ error: 'nicht gefunden' });
    return;
  }
  try {
    const client = createClient(server);
    await client.init();
    const tools = await client.listTools();
    if (typeof client.stop === 'function') client.stop();
    res.json({ ok: true, tools: tools.map((t) => t.name) });
  } catch (e) {
    res.json({ ok: false, error: String(e) });
  }
});

mcpRoutes.put('/admin/api/prompts/:key', requireAuth, (req, res) => {
  const body = req.body as { content?: string };
  if (typeof body.content !== 'string') {
    res.status(400).json({ error: 'content erforderlich' });
    return;
  }
  setPrompt(String(req.params.key), body.content);
  res.json({ ok: true });
});

mcpRoutes.get('/admin/api/logs', requireAuth, (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
  res.json({ logs: listLogs(limit) });
});

mcpRoutes.get('/admin/api/usage', requireAuth, (_req, res) => {
  res.json({ usage: summarizeUsage() });
});
