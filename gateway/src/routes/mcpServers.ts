import { Router } from 'express';
import { requireAdminAuth } from '../auth.js';
import { errMsg, parseId } from './helpers.js';
import {
  deleteMcpServer,
  createMcpServer,
  getMcpServer,
  listFunctions,
  listMcpServers,
  maskMcpServerSecrets,
  updateMcpServer,
  type McpServerInput,
} from '../db.js';
import { createClient, getMcpContext, invalidateMcpCache } from '../mcp/registry.js';
import { normalizeHeaders } from '../core/normalize.js';
export const mcpServersRoutes = Router();

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
      // an, ein leeres Feld darf die bestehenden Secrets nicht wischen .
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
    headers: transport === 'http' ? normalizeHeaders(body.headers) : null,
    npm_spec: transport === 'stdio' && body.npm_spec ? String(body.npm_spec).trim() || null : null,
    inventory_prompt: body.inventory_prompt == null ? null : String(body.inventory_prompt).trim() || null,
    side_effect: body.side_effect === 'read' ? 'read' : 'write',
    enabled: body.enabled === false || body.enabled === 0 || body.enabled === '0' || body.enabled === 'false' ? 0 : 1,
  };
}

mcpServersRoutes.get('/admin/api/mcp-servers', requireAdminAuth, (_req, res) => {
  res.json({ servers: listMcpServers(false) });
});

// Alle fuer LLM-Actions verfuegbaren Tools (Facade + MCP) fuer den Web-Editor
mcpServersRoutes.get('/admin/api/tools', requireAdminAuth, async (_req, res) => {
  try {
    const mcp = await getMcpContext();
    const serverTools = mcp.servers.map((s) => ({ server: s.name, tools: s.tools.map((t) => t.name) }));
    const functions = listFunctions(true).map((f) => `fn_${f.name}`);
    res.json({ mcp: serverTools, functions });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

mcpServersRoutes.post('/admin/api/mcp-servers', requireAdminAuth, (req, res) => {
  try {
    const server = createMcpServer(normalizeServerInput(req.body as Record<string, unknown>));
    invalidateMcpCache();
    res.json({ server: maskMcpServerSecrets(server) });
  } catch (e) {
    res.status(400).json({ error: errMsg(e) });
  }
});

mcpServersRoutes.put('/admin/api/mcp-servers/:id', requireAdminAuth, (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: 'ungueltige ID' });
    return;
  }
  try {
    const updated = updateMcpServer(
      id,
      normalizeServerInput(req.body as Record<string, unknown>),
      Array.isArray((req.body as { clear_secrets?: unknown }).clear_secrets)
        ? ((req.body as { clear_secrets: unknown[] }).clear_secrets.filter((v): v is string => typeof v === 'string'))
        : []
    );
    invalidateMcpCache();
    if (!updated) {
      res.status(404).json({ error: 'nicht gefunden' });
      return;
    }
    res.json({ server: maskMcpServerSecrets(updated) });
  } catch (e) {
    res.status(400).json({ error: errMsg(e) });
  }
});

mcpServersRoutes.delete('/admin/api/mcp-servers/:id', requireAdminAuth, (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: 'ungueltige ID' });
    return;
  }
  deleteMcpServer(id);
  invalidateMcpCache();
  res.json({ ok: true });
});

mcpServersRoutes.post('/admin/api/mcp-servers/:id/health', requireAdminAuth, async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: 'ungueltige ID' });
    return;
  }
  const server = getMcpServer(id);
  if (!server) {
    res.status(404).json({ error: 'nicht gefunden' });
    return;
  }
  const client = createClient(server);
  try {
    await client.init();
    const tools = await client.listTools();
    res.json({ ok: true, tools: tools.map((t) => t.name) });
  } catch (e) {
    res.json({ ok: false, error: String(e) });
  } finally {
    // Auch im Fehlerfall beenden, sonst bleibt ein stdio-Kindprozess zurueck
    // (Prozessleck bei wiederholten Health-Checks).
    if (typeof client.stop === 'function') client.stop();
  }
});
