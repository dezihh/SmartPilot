import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chatCompletion, type ChatMessage } from '../src/llm/client.js';
import { initDb, closeDb } from '../src/db/schema.js';
import { tmpDb } from './_tmpdb.js';

const DB_PATH = tmpDb('llmclient');

const originalFetch = globalThis.fetch;

interface LlmStub {
  respond?: (url: string, body: Record<string, unknown>) => { status?: number; data?: unknown };
}

let calls: { url: string; model?: string; tools?: number; signal?: AbortSignal }[] = [];
let stub: LlmStub = {};

function chatJson(model: string, content: string | null): Record<string, unknown> {
  return {
    model,
    choices: [{ message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function stubFetchLlm(): void {
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({
      url: u,
      model: body.model as string,
      tools: Array.isArray(body.tools) ? (body.tools as unknown[]).length : undefined,
      signal: init?.signal as AbortSignal | undefined,
    });
    const r = stub.respond?.(u, body) ?? { status: 500, data: {} };
    const res = {
      ok: (r.status ?? 200) >= 200 && (r.status ?? 200) < 300,
      status: r.status ?? 200,
      text: async () => JSON.stringify(r.data ?? {}),
      json: async () => r.data ?? {},
    };
    return res as unknown as Response;
  }) as typeof fetch;
}

const msgs: ChatMessage[] = [{ role: 'user', content: 'frage' }];

before(() => {
  closeDb();
  initDb(DB_PATH);
});

beforeEach(() => {
  calls = [];
  stub = {};
  stubFetchLlm();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

after(() => {
  globalThis.fetch = originalFetch;
});

test('chatCompletion: Modell-Echo aus der Antwort landet in usage.model', async () => {
  stub.respond = () => ({ data: chatJson('gpt-oss-120b', 'antwort') });
  const r = await chatCompletion(msgs);
  assert.equal(r.message.content, 'antwort');
  assert.equal(r.usage?.model, 'gpt-oss-120b');
});

test('chatCompletion: cached-Flag via cache_read_input_tokens', async () => {
  stub.respond = () => ({
    data: { ...chatJson('m', 'x'), usage: { prompt_tokens: 1, completion_tokens: 1, cache_read_input_tokens: 1000 } },
  });
  const r = await chatCompletion(msgs);
  assert.equal(r.usage?.cached, true);
});

test('chatCompletion: ohne usage bleibt usage undefined', async () => {
  stub.respond = () => ({ data: { choices: [{ message: { role: 'assistant', content: 'y' } }] } });
  const r = await chatCompletion(msgs);
  assert.equal(r.usage, undefined);
});

test('Tool-Runden gehen ans Primaermodell', async () => {
  stub.respond = () => ({ data: chatJson('primary', 'tool-antwort') });
  await chatCompletion(msgs, [{ type: 'function', function: { name: 'x', parameters: {} } }], 1000);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tools, 1);
});

test('Primaerfehler -> klare Rejection', async () => {
  stub.respond = () => ({ status: 500, data: {} });
  await assert.rejects(() => chatCompletion(msgs, undefined, 3000), /LLM 500/);
});

test('chatCompletion reicht bei Timeout ein Abbruch-Signal an fetch weiter', async () => {
  stub.respond = () => ({ data: chatJson('m', 'ok') });
  await chatCompletion(msgs, undefined, 1000);
  assert.ok(calls[0].signal instanceof AbortSignal);
});
