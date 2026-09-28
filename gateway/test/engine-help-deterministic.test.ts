// Engine: die geseedete Hilfe wird deterministisch beantwortet (kein LLM) und
// spiegelt die installierten Faehigkeiten. Eigene llm-Vorgaenge bleiben beim LLM.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.AUTH_TOKEN = 'test-secret';
process.env.LLM_BASE_URL = 'http://127.0.0.1:9/v1';
process.env.LLM_API_KEY = 'test-key';
process.env.LLM_MODEL = 'test-model';

const { tmpDb } = await import('./_tmpdb.js');
const { initDb, closeDb, getDb } = await import('../src/db/schema.js');
const { createAction } = await import('../src/db/actions.js');
const { createFunction } = await import('../src/db/functions.js');
const { processQuery } = await import('../src/core/engine.js');

let llmCalls = 0;

function stubFetch(): void {
  globalThis.fetch = (async (url: string | URL) => {
    if (String(url).includes('chat/completions')) {
      llmCalls += 1;
      const data = { choices: [{ message: { role: 'assistant', content: 'LLM-Antwort.' } }] };
      return { ok: true, status: 200, text: async () => JSON.stringify(data), json: async () => data } as unknown as Response;
    }
    return { ok: true, status: 204, headers: { get: () => null }, text: async () => '', json: async () => ({}) } as unknown as Response;
  }) as typeof fetch;
}

before(() => {
  closeDb();
  initDb(tmpDb('help-engine'));
  const db = getDb();
  db.exec('DELETE FROM actions; DELETE FROM tpl_functions; DELETE FROM mcp_servers;');
  createAction({
    name: 'hilfe',
    mode: 'llm',
    trigger_phrases: '["hilfe"]',
    fuzzy_threshold: 0.85,
    system_prompt: 'Hilfe-Anfrage: was kann {assistant_name}? {agent_inventory}',
    template: null,
    function_ref: null,
    function_args: null,
    tools: '[]',
    enabled: 1,
  });
});

beforeEach(() => {
  llmCalls = 0;
  stubFetch();
  getDb().exec('DELETE FROM tpl_functions;');
});

after(() => {
  closeDb();
});

test('Hilfe ohne Tools: deterministisch, kein LLM-Aufruf', async () => {
  const r = await processQuery({ text: 'hilfe', sessionId: 'help-empty' });
  assert.equal(r.route, 'action');
  assert.match(r.response.speech, /keine Fähigkeiten eingerichtet/);
  assert.match(r.response.speech, /wie heisst du/);
  assert.equal(llmCalls, 0, 'Hilfe darf das LLM nicht bemuehen');
});

test('Hilfe listet installierte Funktion, weiterhin ohne LLM', async () => {
  createFunction({
    name: 'wetter',
    description: null,
    template: 'x',
    parameters: null,
    budget: null,
    inventory_prompt: 'Aktuelles Wetter und 3-Tage-Vorhersage',
    enabled: 1,
  });
  const r = await processQuery({ text: 'hilfe', sessionId: 'help-tools' });
  assert.equal(r.route, 'action');
  assert.match(r.response.speech, /Das kann ich aktuell:/);
  assert.match(r.response.speech, /- wetter: Aktuelles Wetter und 3-Tage-Vorhersage/);
  assert.equal(llmCalls, 0);
});

test('eigener llm-Vorgang (ohne Seed-Marker) bleibt beim LLM', async () => {
  createAction({
    name: 'test_llm',
    mode: 'llm',
    trigger_phrases: '["test-llm-marker"]',
    fuzzy_threshold: 0.85,
    system_prompt: 'Eigener Vorgang {agent_inventory}',
    template: null,
    function_ref: null,
    function_args: null,
    tools: '[]',
    enabled: 1,
  });
  const r = await processQuery({ text: 'test-llm-marker', sessionId: 'llm-path' });
  assert.equal(r.route, 'action');
  assert.equal(llmCalls, 1);
});
