import { Router } from 'express';
import type { TraceEvent } from '../types.js';
import { requireAdminAuth } from '../auth.js';
import { errMsg, parseId } from './helpers.js';
import { config } from '../config.js';
import {
  createAction,
  deleteAction,
  deleteFunction,
  deleteSetting,
  getAction,
  getSettings,
  listActions,
  listFunctions,
  createFunction,
  listMcpServers,
  listPrompts,
  restoreDefaultSettings,
  setSetting,
  maskSettings,
  secretSettingFlags,
  SECRET_SETTING_KEYS,
  updateAction,
  updateFunction,
} from '../db.js';
import { SEED_SETTINGS } from '../db/schema.js';
import { SEED_AGENT_SYSTEM, SEED_AGENT_INVENTORY } from '../db/seeds.js';
import { normalizeActionInput, normalizeFunctionInput } from '../core/normalize.js';
import { HTTP_BODY_CAP, HTTP_TIMEOUT_MS } from '../core/http.js';
import { parseHttpHeaders, parsePrivateAllow } from '../core/httpHeaders.js';
import { MASKED_SETTING } from '../db/settings.js';
import { renderActionTemplate } from '../core/template.js';
import { assistIndex, applyDraft, type IndexDraft } from '../core/indexAssistant.js';
import { invalidateIndex } from '../core/entityIndex.js';
import { getMcpContext } from '../mcp/registry.js';
export const adminRoutes = Router();

const INDEX_KEY_RE = /^[a-z0-9_-]{1,30}$/;
const INDEX_KEY_ERROR = 'Ungültiger Key (a-z 0-9 _ -, max. 30)';

adminRoutes.get('/admin/api/bootstrap', requireAdminAuth, (_req, res) => {
  const rawSettings = getSettings();
  res.json({
    settings: maskSettings(rawSettings),
    settingSet: secretSettingFlags(rawSettings),
    // Effektive Defaults (aus .env bzw. Code) fuer die Web-UI-Platzhalter:
    // leeres Setting = dieser Wert gilt.
    settingDefaults: {
      llm_model: config.llm.model,
      llm_max_tokens: String(config.llm.maxTokens),
      llm_reasoning_effort: config.llm.reasoningEffort ?? '',
      tool_deadline_ms: String(config.toolDeadlineMs),
      max_tool_iterations: String(config.maxToolIterations),
      http_timeout_ms: String(HTTP_TIMEOUT_MS),
      http_body_cap: String(HTTP_BODY_CAP),
      ...Object.fromEntries(SEED_SETTINGS),
    },
    actions: listActions(false),
    functions: listFunctions(false),
    servers: listMcpServers(false),
    prompts: listPrompts(),
    // Referenz-Texte der frischen Installation (fuer 'Original' im Prompt-Editor).
    seedPrompts: { agent_system: SEED_AGENT_SYSTEM, agent_inventory: SEED_AGENT_INVENTORY },
  });
});

adminRoutes.put('/admin/api/settings', requireAdminAuth, (req, res) => {
  const body = req.body as { settings?: Record<string, string> };
  if (!body.settings || typeof body.settings !== 'object') {
    res.status(400).json({ error: 'settings-Objekt erforderlich' });
    return;
  }
  try {
    for (const [key, value] of Object.entries(body.settings)) {
      // Geheim-Settings: leer bzw. maskiert = bestehenden Wert behalten.
      if (SECRET_SETTING_KEYS.has(key)) {
        if (value === '' || value === MASKED_SETTING) continue;
        // {} ist die ausdrueckliche Loeschung, nicht "leer = behalten".
        if (key === 'http_headers' && parseHttpHeaders(String(value)).size === 0) {
          deleteSetting(key);
          continue;
        }
      } else if (key === 'http_private_allow') {
        parsePrivateAllow(String(value));
      }
      setSetting(key, String(value));
    }
  } catch (e) {
    res.status(400).json({ error: errMsg(e) });
    return;
  }
  const rawSettings = getSettings();
  res.json({ settings: maskSettings(rawSettings), settingSet: secretSettingFlags(rawSettings) });
});

adminRoutes.post('/admin/api/settings/restore-defaults', requireAdminAuth, (_req, res) => {
  restoreDefaultSettings();
  const rawSettings = getSettings();
  res.json({ settings: maskSettings(rawSettings), settingSet: secretSettingFlags(rawSettings) });
});

adminRoutes.get('/admin/api/actions', requireAdminAuth, (_req, res) => {
  res.json({ actions: listActions(false) });
});

adminRoutes.get('/admin/api/functions', requireAdminAuth, (_req, res) => {
  res.json({ functions: listFunctions(false) });
});

adminRoutes.post('/admin/api/functions', requireAdminAuth, (req, res) => {
  try {
    const fn = createFunction(normalizeFunctionInput(req.body as Record<string, unknown>));
    res.json({ function: fn });
  } catch (e) {
    res.status(400).json({ error: errMsg(e) });
  }
});

adminRoutes.put('/admin/api/functions/:id', requireAdminAuth, (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'ungueltige ID' });
  try {
    const fn = updateFunction(id, normalizeFunctionInput(req.body as Record<string, unknown>));
    if (!fn) return res.status(404).json({ error: 'Funktion nicht gefunden' });
    res.json({ function: fn });
  } catch (e) {
    res.status(400).json({ error: errMsg(e) });
  }
});

adminRoutes.delete('/admin/api/functions/:id', requireAdminAuth, (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'ungueltige ID' });
  deleteFunction(id);
  res.json({ ok: true });
});

// Index-Quellen: universale benannte Snapshot-Indexe (entity_index = Default,
// entity_index_<key> = benannt). Der Desc-Feldwert lebt im Config-JSON
// ("desc") und wird vom Index-Loader ignoriert.
adminRoutes.get('/admin/api/indexes', requireAdminAuth, (_req, res) => {
  const settings = getSettings();
  const indexes: { key: string; config: string }[] = [];
  for (const [key, value] of Object.entries(settings)) {
    if (key === 'entity_index') {
      indexes.push({ key: '', config: value });
    } else if (key.startsWith('entity_index_')) {
      indexes.push({ key: key.slice('entity_index_'.length), config: value });
    }
  }
  res.json({ indexes });
});

adminRoutes.put('/admin/api/indexes/:key', requireAdminAuth, async (req, res) => {
  const key = String(req.params.key ?? '').toLowerCase();
  if (key && !INDEX_KEY_RE.test(key)) return res.status(400).json({ error: INDEX_KEY_ERROR });
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(String(req.body.config ?? '')) as Record<string, unknown>;
  } catch {
    return res.status(400).json({ error: 'Config ist kein gültiges JSON' });
  }
  if (!obj || typeof obj !== 'object' || typeof obj.tool !== 'string' || !(obj.tool as string).trim()) {
    return res.status(400).json({ error: 'Config braucht ein "tool"' });
  }
  setSetting(key ? `entity_index_${key}` : 'entity_index', JSON.stringify(obj));
  invalidateIndex();
  res.json({ ok: true, key });
});

adminRoutes.delete('/admin/api/indexes/:key', requireAdminAuth, (req, res) => {
  const key = String(req.params.key ?? '').toLowerCase();
  if (!key || !INDEX_KEY_RE.test(key)) {
    return res.status(400).json({ error: 'Nur benannte Indexe löschbar (Default-Index leeren statt löschen)' });
  }
  deleteSetting(`entity_index_${key}`);
  invalidateIndex();
  res.json({ ok: true });
});

// Vorschau: Template direkt rendern (mit echtem MCP-Kontext), fuer den Funktionen-Editor
adminRoutes.post('/admin/api/functions/preview', requireAdminAuth, async (req, res) => {
  try {
    const template = String((req.body as { template?: unknown }).template ?? '');
    const argsRaw = (req.body as { args?: unknown }).args;
    const args =
      argsRaw && typeof argsRaw === 'object' && !Array.isArray(argsRaw)
        ? (argsRaw as Record<string, unknown>)
        : {};
    const mcp = await getMcpContext();
    const trace: TraceEvent[] = [];
    const rendered = await renderActionTemplate(template, mcp, trace, args);
    res.json({ rendered, trace });
  } catch (e) {
    res.status(400).json({ error: errMsg(e) });
  }
});

// Index-Assistent (Phase 2): LLM entwirft ein Index-Draft, der deterministische
// Validator prueft es live (lesende Tools only, Datenvertrag). Speichern nur
// ueber /index/apply nach Admin-Bestaetigung.
adminRoutes.post('/admin/api/index/assist', requireAdminAuth, async (req, res) => {
  try {
    const goal = String((req.body as { goal?: unknown }).goal ?? '');
    const indexKey = String((req.body as { indexKey?: unknown }).indexKey ?? '')
      .trim()
      .toLowerCase();
    if (indexKey && !INDEX_KEY_RE.test(indexKey)) return res.status(400).json({ error: INDEX_KEY_ERROR });
    res.json(await assistIndex(goal, indexKey));
  } catch (e) {
    res.status(400).json({ error: errMsg(e) });
  }
});

adminRoutes.post('/admin/api/index/apply', requireAdminAuth, async (req, res) => {
  try {
    const draft = (req.body as { draft?: unknown }).draft;
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
      return res.status(400).json({ error: 'Draft fehlt' });
    }
    const indexKey = String((req.body as { indexKey?: unknown }).indexKey ?? '')
      .trim()
      .toLowerCase();
    if (indexKey && !INDEX_KEY_RE.test(indexKey)) return res.status(400).json({ error: INDEX_KEY_ERROR });
    res.json(await applyDraft(draft as IndexDraft, indexKey));
  } catch (e) {
    res.status(400).json({ error: errMsg(e) });
  }
});

adminRoutes.post('/admin/api/actions', requireAdminAuth, (req, res) => {
  try {
    res.json({ action: createAction(normalizeActionInput(req.body as Record<string, unknown>)) });
  } catch (e) {
    res.status(400).json({ error: errMsg(e) });
  }
});

adminRoutes.put('/admin/api/actions/:id', requireAdminAuth, (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'ungueltige ID' });
  const existing = getAction(id);
  if (!existing) {
    res.status(404).json({ error: 'nicht gefunden' });
    return;
  }
  try {
    const updated = updateAction(id, normalizeActionInput(req.body as Record<string, unknown>));
    res.json({ action: updated });
  } catch (e) {
    res.status(400).json({ error: errMsg(e) });
  }
});

adminRoutes.delete('/admin/api/actions/:id', requireAdminAuth, (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'ungueltige ID' });
  deleteAction(id);
  res.json({ ok: true });
});

