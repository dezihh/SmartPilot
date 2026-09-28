// Review v0.1.1..v0.1.2 (b7d1297): Ein llm-Vorgang mit leerer Tool-Liste (die
// Hilfe) muss ALLE System-Noten ins Nachschlagewerk aufnehmen, damit das LLM
// keine Faehigkeiten erfindet. Eine nicht passende Tool-Liste filtert weiter.
//
// config/auth lesen die Umgebung beim Import -> vor den dynamischen Importen setzen.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.AUTH_TOKEN = 'test-secret';
process.env.LLM_BASE_URL = 'http://127.0.0.1:9/v1';
process.env.LLM_API_KEY = 'test-key';
process.env.LLM_MODEL = 'test-model';

const { tmpDb } = await import('./_tmpdb.js');
const { initDb, closeDb, getDb } = await import('../src/db/schema.js');
const { createAction } = await import('../src/db/actions.js');
const { setPrompt } = await import('../src/db/settings.js');
const { createMcpServer } = await import('../src/db/mcpServers.js');
const { invalidateMcpCache } = await import('../src/mcp/registry.js');
const { processQuery } = await import('../src/core/engine.js');

const SERVER_NOTE = 'Test-System: kann ausdruecklich nur Testkram';

let llmBodies: { messages: { role: string; content: string | null }[] }[] = [];

function stubFetch(): void {
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const target = String(url);
    if (target.includes('chat/completions')) {
      llmBodies.push(JSON.parse(String(init?.body ?? '{}')) as { messages: { role: string; content: string | null }[] });
      const data = { choices: [{ message: { role: 'assistant', content: 'Scope-Antwort.' } }] };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(data),
        json: async () => data,
      } as unknown as Response;
    }
    // MCP-JSON-RPC-Stub des registrierten Servers
    const body = JSON.parse(String(init?.body ?? '{}')) as { method?: string };
    if (body.method === 'initialize') {
      return {
        ok: true,
        status: 200,
        headers: { get: (n: string) => (n.toLowerCase() === 'mcp-session-id' ? 's1' : null) },
        text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }),
        json: async () => ({ jsonrpc: '2.0', id: 1, result: {} }),
      } as unknown as Response;
    }
    if (body.method === 'tools/list') {
      const result = { tools: [{ name: 'x', description: '' }] };
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result }),
        json: async () => ({ jsonrpc: '2.0', id: 1, result }),
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 202,
      headers: { get: () => null },
      text: async () => '',
      json: async () => ({}),
    } as unknown as Response;
  }) as typeof fetch;
}

function systemMessage(): string {
  const body = llmBodies.at(-1);
  return body?.messages.find((m) => m.role === 'system')?.content ?? '';
}

before(() => {
  closeDb();
  initDb(tmpDb('engine-help'));
  const db = getDb();
  db.exec('DELETE FROM actions; DELETE FROM mcp_servers; DELETE FROM settings; DELETE FROM prompts;');
  setPrompt('agent_inventory', 'REGELN\n{{AGENT_FNS}}');
  createMcpServer({
    name: 'test-system',
    url: 'https://mcp.example.org/rpc',
    auth_token: null,
    transport: 'http',
    command: null,
    args: null,
    env: null,
    inventory_prompt: SERVER_NOTE,
    enabled: 1,
  });
});

beforeEach(() => {
  llmBodies = [];
  stubFetch();
  invalidateMcpCache();
});

after(() => {
  invalidateMcpCache();
  closeDb();
});

test('llm-Vorgang mit leerer Tool-Liste nimmt alle System-Noten auf (Hilfe)', async () => {
  createAction({
    name: 'test_scope_leer',
    mode: 'llm',
    trigger_phrases: '["scope-leer-test"]',
    fuzzy_threshold: 0.85,
    system_prompt: 'HILFE\n{agent_inventory}',
    template: null,
    function_ref: null,
    function_args: null,
    tools: '[]',
    enabled: 1,
  });
  const r = await processQuery({ text: 'scope-leer-test', sessionId: 'scope-leer' });
  assert.equal(r.route, 'action');
  assert.match(systemMessage(), new RegExp(SERVER_NOTE), 'leere Tool-Liste = alle Systeme sichtbar');
});

test('llm-Vorgang mit nicht passender Tool-Liste filtert die System-Noten heraus', async () => {
  createAction({
    name: 'test_scope_filter',
    mode: 'llm',
    trigger_phrases: '["scope-filter-test"]',
    fuzzy_threshold: 0.85,
    system_prompt: 'HILFE\n{agent_inventory}',
    template: null,
    function_ref: null,
    function_args: null,
    tools: '["gibts_nicht"]',
    enabled: 1,
  });
  const r = await processQuery({ text: 'scope-filter-test', sessionId: 'scope-filter' });
  assert.equal(r.route, 'action');
  const sys = systemMessage();
  assert.doesNotMatch(sys, new RegExp(SERVER_NOTE), 'gefilterte Tool-Liste darf das System nicht nennen');
  assert.match(sys, /keine Funktionen oder Systeme eingerichtet/, 'Leer-Fallback statt rohem Marker');
});
