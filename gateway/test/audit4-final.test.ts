// Restliche Coverage-Lücken (Audit F-001): Prompt-Route, SSML-Umbruch bei
// langen Sätzen, Query-Längenlimit und der HTTP-Baustein.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.ADMIN_TOKEN = 'test-admin-secret';
process.env.API_TOKEN = 'test-query-secret';
process.env.LLM_BASE_URL = 'http://127.0.0.1:9/v1';
process.env.LLM_API_KEY = 'test-key';
process.env.LLM_MODEL = 'test-model';
process.env.QUERY_MAX_CHARS = '10';

const { tmpDb } = await import('./_tmpdb.js');
const { initDb, closeDb } = await import('../src/db/schema.js');
const { getPrompt } = await import('../src/db/settings.js');
const { createApp } = await import('../src/app.js');
const { withSsmlBreaks } = await import('../src/core/response.js');
const { fetchUrl, setPinDispatcherFactoryForTests } = await import('../src/core/http.js');

closeDb();
initDb(tmpDb('audit4-final'));

const app = createApp();
const server = app.listen(0);
await new Promise<void>((resolve) => server.once('listening', () => resolve()));
const PORT = (server.address() as AddressInfo).port;

const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
  server.close();
  closeDb();
});

function call(method: string, path: string, body?: unknown, token = 'test-admin-secret'): Promise<number> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = request(
      {
        host: '127.0.0.1',
        port: PORT,
        path,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end(payload ?? undefined);
  });
}

test('Prompt-Route: fehlender Inhalt wird abgelehnt', async () => {
  assert.equal(await call('PUT', '/admin/api/prompts/agent_system', {}), 400);
});

test('Prompt-Route: Inhalt wird gespeichert', async () => {
  assert.equal(await call('PUT', '/admin/api/prompts/test_key', { content: 'Hallo' }), 200);
  assert.equal(getPrompt('test_key'), 'Hallo');
});

test('Query: zu langer Text wird mit 413 abgelehnt', async () => {
  assert.equal(await call('POST', '/api/query', { text: 'viel zu lang fuer das Limit' }, 'test-query-secret'), 413);
});

test('withSsmlBreaks: langer Satztext ohne Absaetze wird in SSML umbrochen', () => {
  const long = 'Der erste Satz ist lang genug. '.repeat(6).trim();
  assert.ok(long.length >= 160);
  const out = withSsmlBreaks({ speech: long, ssml: false });
  assert.equal(out.ssml, true);
  assert.match(out.speech, /^<speak>/);
});

test('fetchUrl: JSON-Antwort wird geparst', async () => {
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    body: null,
    text: async () => '{"a":1}',
  })) as unknown as typeof fetch;
  const trace: unknown[] = [];
  assert.deepEqual(await fetchUrl('https://example.org/x', trace as never, false), { a: 1 });
});

test('fetchUrl: Nicht-OK liefert null und einen Fehler-Trace', async () => {
  globalThis.fetch = (async () => ({
    ok: false,
    status: 500,
    headers: { get: () => null },
    body: null,
    text: async () => 'kaputt',
  })) as unknown as typeof fetch;
  const trace: { step: string }[] = [];
  assert.equal(await fetchUrl('https://example.org/x', trace as never, false), null);
  assert.ok(trace.some((t) => t.step === 'template.http.error'));
});

test('fetchUrl: Klartext wird unverändert zurückgegeben', async () => {
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'text/plain' },
    body: null,
    text: async () => 'hallo welt',
  })) as unknown as typeof fetch;
  assert.equal(await fetchUrl('https://example.org/x', [] as never, false), 'hallo welt');
});

test('setPinDispatcherFactoryForTests: Zurücksetzen ist möglich', () => {
  setPinDispatcherFactoryForTests();
  setPinDispatcherFactoryForTests();
});
