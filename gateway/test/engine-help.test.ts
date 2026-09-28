// Engine: die geseedete Hilfe laeuft ueber das LLM, bekommt aber den
// VOLLSTAENDIGEN Faehigkeiten-Katalog (nicht das gefilterte Inventar). Ohne
// Tools oder bei LLM-Fehler greift der deterministische Fallback.
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
const { setSetting, deleteSetting } = await import('../src/db/settings.js');
const { processQuery } = await import('../src/core/engine.js');

let llmCalls = 0;
let failLlm = false;
let lastMessages: { role: string; content: string | null }[] = [];

function stubFetch(): void {
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    if (String(url).includes('chat/completions')) {
      llmCalls += 1;
      lastMessages = (JSON.parse(String(init?.body ?? '{}')).messages ?? []) as typeof lastMessages;
      if (failLlm) {
        return { ok: false, status: 500, text: async () => 'boom', json: async () => ({}) } as unknown as Response;
      }
      const data = { choices: [{ message: { role: 'assistant', content: '{"speech":"Hilfe-Antwort.","keep_open":true}' } }] };
      return { ok: true, status: 200, text: async () => JSON.stringify(data), json: async () => data } as unknown as Response;
    }
    return { ok: true, status: 204, headers: { get: () => null }, text: async () => '', json: async () => ({}) } as unknown as Response;
  }) as typeof fetch;
}

function systemMessage(): string {
  return lastMessages.find((m) => m.role === 'system')?.content ?? '';
}

function fn(name: string, description: string): void {
  createFunction({ name, description, template: 'x', parameters: null, budget: null, inventory_prompt: null, enabled: 1 });
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
  failLlm = false;
  lastMessages = [];
  stubFetch();
  deleteSetting('agent_tools');
  getDb().exec('DELETE FROM tpl_functions;');
});

after(() => {
  closeDb();
});

test('Hilfe mit Tool: LLM bekommt den vollstaendigen Katalog', async () => {
  fn('wetter', 'Wetter und 3-Tage-Vorhersage');
  const r = await processQuery({ text: 'hilfe', sessionId: 'help-tools' });
  assert.equal(r.route, 'action');
  assert.equal(r.response.speech, 'Hilfe-Antwort.');
  assert.equal(llmCalls, 1);
  assert.match(systemMessage(), /## Werkzeuge/);
  assert.match(systemMessage(), /- wetter: Wetter und 3-Tage-Vorhersage/);
});

test('Hilfe ohne Tools: deterministischer Fallback, kein LLM', async () => {
  const r = await processQuery({ text: 'hilfe', sessionId: 'help-empty' });
  assert.equal(r.route, 'action');
  assert.match(r.response.speech, /keine Fähigkeiten eingerichtet/);
  assert.equal(llmCalls, 0);
});

test('Hilfe respektiert agent_tools: ausgeschlossenes Tool fehlt (Fallback)', async () => {
  fn('wetter', 'Wetter und 3-Tage-Vorhersage');
  setSetting('agent_tools', 'keine');
  const r = await processQuery({ text: 'hilfe', sessionId: 'help-allow' });
  assert.equal(r.route, 'action');
  assert.match(r.response.speech, /keine Fähigkeiten eingerichtet/);
  assert.equal(llmCalls, 0);
});

test('LLM-Fehler: Fallback statt Absturz', async () => {
  fn('wetter', 'Wetter und 3-Tage-Vorhersage');
  failLlm = true;
  const r = await processQuery({ text: 'hilfe', sessionId: 'help-fail' });
  assert.equal(r.route, 'action');
  assert.match(r.response.speech, /Das kann ich aktuell:/);
  assert.equal(llmCalls, 1);
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

test('Hilfe folgt der agent_tools-Allowlist: ausgeschlossenes Tool fehlt', async () => {
  fn('erlaubt', 'Freigegebenes Tool');
  fn('geheim', 'Nur fuer den Admin gedacht');
  setSetting('agent_tools', 'fn_erlaubt');
  const r = await processQuery({ text: 'hilfe', sessionId: 'help-allowlist' });
  assert.equal(r.route, 'action');
  assert.equal(llmCalls, 1);
  assert.match(systemMessage(), /- erlaubt: Freigegebenes Tool/);
  assert.doesNotMatch(systemMessage(), /geheim/, 'ausgeschlossenes Tool darf im Katalog fehlen');
});
