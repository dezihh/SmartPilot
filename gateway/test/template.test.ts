import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { renderActionTemplate, renderFunction } from '../src/core/template.js';
import { initDb, closeDb, getDb } from '../src/db/schema.js';
import { createFunction } from '../src/db/functions.js';
import { resetHttpCacheForTests } from '../src/core/httpCache.js';
import type { McpContext, McpServerContext } from '../src/mcp/registry.js';
import type { TraceEvent } from '../src/types.js';
import { tmpDb } from './_tmpdb.js';

const DB_PATH = tmpDb('template');

before(() => {
  closeDb(); // hermetisch: Container-DB durch Temp-DB ersetzen
  initDb(DB_PATH);
  resetHttpCacheForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

after(() => {
  globalThis.fetch = originalFetch;
  const db = getDb();
  db.exec("DELETE FROM tpl_functions WHERE name LIKE 'test_fn%'");
  closeDb();
});

const originalFetch = globalThis.fetch;

interface FakeRes {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  headers: { get: (name: string) => string | null };
}

let fetchCalls: string[] = [];
let fetchHandler: (url: string) => FakeRes = () => ({
  ok: true,
  status: 200,
  text: async () => '{"quelle":"test"}',
  headers: { get: () => null },
});

function defaultHandler(): FakeRes {
  return { ok: true, status: 200, text: async () => '{"quelle":"test"}', headers: { get: () => null } };
}

function stubFetch(handler?: (url: string) => FakeRes): void {
  fetchHandler = handler ?? defaultHandler;
  fetchCalls = [];
  globalThis.fetch = (async (url: string | URL) => {
    fetchCalls.push(String(url));
    return fetchHandler(String(url));
  }) as typeof fetch;
}

function fakeMcp(): McpContext {
  const server: McpServerContext = {
    id: 1,
    name: 'test-mcp',
    sideEffect: 'write',
    tools: [{ name: 'tool_x' }],
    client: {
      init: async () => {},
      listTools: async () => [{ name: 'tool_x' }],
      callTool: async (name, args) => ({
        content: [{ type: 'text', text: JSON.stringify({ tool: name, args }) }],
      }),
    },
  };
  return { servers: [server] };
}

const mcp = fakeMcp();

function findStep(trace: TraceEvent[], step: string): TraceEvent | undefined {
  return trace.find((t) => t.step === step);
}

test('render: Klartext-Template', async () => {
  const r = await renderActionTemplate('Hallo Welt', mcp, []);
  assert.equal(r.speech, 'Hallo Welt');
});

test('render: <speak>-Ausgabe bleibt SSML', async () => {
  const r = await renderActionTemplate('<speak>Hallo <break time="300ms"/></speak>', mcp, []);
  assert.equal(r.speech, '<speak>Hallo <break time="300ms"/></speak>');
  assert.equal(r.ssml, true);
});

test('render: JSON-Envelope mit speech + display', async () => {
  const tpl = '{"speech":"Kurzinfo","display":{"title":"Titel","body":"Inhalt"}}';
  const r = await renderActionTemplate(tpl, mcp, []);
  assert.equal(r.speech, 'Kurzinfo');
  assert.deepEqual(r.display, { title: 'Titel', body: 'Inhalt' });
});

test('mcp.call: Literal-Args werden aufgerufen', async () => {
  const r = await renderActionTemplate(`{{ mcp.call('tool_x', {'q': 'abc'}) }}`, mcp, []);
  assert.match(r.speech, /tool_x/);
  assert.match(r.speech, /"q":"abc"/);
});

test('mcp.call: dynamische Args mit args.x evaluiert im Preheat', async () => {
  const r = await renderFunction('test_fn_dyn', mcp, [], { x: 'wetter' });
  assert.match(r.speech, /"q":"wetter"/);
});

test('mcp.call: unbekanntes Tool -> null + Fehler-Trace', async () => {
  const trace: TraceEvent[] = [];
  const r = await renderActionTemplate(`{{ mcp.call('gibtsnicht') }}`, mcp, trace);
  assert.equal(r.speech, '');
  assert.ok(findStep(trace, 'template.mcp.error'));
});

test('http: Literal-URL wird gefetcht und JSON geparst', async () => {
  stubFetch();
  const r = await renderActionTemplate(`{{ http('https://api.example.org/v1/data') | dump }}`, mcp, []);
  assert.match(r.speech, /"quelle":"test"/);
  assert.equal(fetchCalls.length, 1);
});

test('http: TTL-Cache verhindert zweites Fetchen', async () => {
  stubFetch();
  const tpl = `{{ http('https://cache.example.org/v1/data', 60000) }}`;
  await renderActionTemplate(tpl, mcp, []);
  await renderActionTemplate(tpl, mcp, []);
  assert.equal(fetchCalls.length, 1);
});

test('http: dynamische URL aus args.x wird aufgeloest', async () => {
  stubFetch();
  const r = await renderFunction('test_fn_http', mcp, [], { path: 'v1/x' });
  assert.match(r.speech, /"quelle":"test"/);
  assert.deepEqual(fetchCalls, ['https://api.example.org/v1/x']);
});

test('http: dynamische URL auf privaten Host -> blockiert (SSRF)', async () => {
  stubFetch();
  const trace: TraceEvent[] = [];
  const r = await renderFunction('test_fn_ssrf', mcp, trace, { host: 'localhost:8331' });
  assert.equal(r.speech, '');
  assert.equal(fetchCalls.length, 0, 'kein Fetch ins private Netz');
  assert.ok(findStep(trace, 'template.http.blocked'));
});

test('http: dynamische Redirect-Kette ins private Netz -> blockiert (SSRF)', async () => {
  stubFetch(() => ({
    ok: false,
    status: 302,
    text: async () => '',
    headers: { get: (n) => (n.toLowerCase() === 'location' ? 'http://169.254.169.254/latest/meta-data/' : null) },
  }));
  const trace: TraceEvent[] = [];
  await renderFunction('test_fn_ssrf', mcp, trace, { host: 'redirect.example.org' });
  // 1. Hop extern ok, 2. Hop private -> blocked; kein zweiter Fetch auf die Privat-IP
  assert.ok(findStep(trace, 'template.http.blocked'));
  assert.ok(fetchCalls.length >= 1);
  assert.ok(fetchCalls.every((u) => !u.includes('169.254')), 'keine private IP gefetcht');
});

test('http: Literale private URL bleibt erlaubt (Admin-Templates sind vertrauenswuerdig)', async () => {
  stubFetch();
  const r = await renderActionTemplate(`{{ http('http://127.0.0.1:9/admin/api/bootstrap') | dump }}`, mcp, []);
  assert.match(r.speech, /"quelle":"test"/);
  assert.equal(fetchCalls.length, 1);
});

test('shell: Literal-Befehl laeuft', async () => {
  const r = await renderActionTemplate(`{{ shell('echo test-echo-hallo') }}`, mcp, []);
  assert.equal(r.speech, 'test-echo-hallo');
});

test('shell: dynamischer Befehl aus args ist NICHT ausfuehrbar (Security)', async () => {
  const trace: TraceEvent[] = [];
  const r = await renderActionTemplate(`{{ shell('echo ' ~ args.x) }}`, mcp, trace, { x: 'boese' });
  assert.equal(r.speech, '');
  assert.equal(findStep(trace, 'template.shell'), undefined, 'kein Shell-Aufruf ueber args');
});

test('shell: haengender Befehl wird vom Timeout abgeschnitten', { timeout: 15000 }, async () => {
  const trace: TraceEvent[] = [];
  const r = await renderActionTemplate(`{{ shell('sleep 8') }}`, mcp, trace);
  assert.equal(r.speech, '');
  assert.ok(findStep(trace, 'template.shell.error'));
});

test('fn: Zyklen werden erkannt und abgebrochen', async () => {
  const trace: TraceEvent[] = [];
  const r = await renderFunction('test_fn_a', mcp, trace);
  const errs = trace.filter((t) => t.step === 'fn.error');
  assert.ok(errs.some((t) => String((t.detail as { reason?: string }).reason) === 'zyklus'), `trace=${JSON.stringify(errs)}`);
  // Abbruch liefert Teil-Output, keine Endlosschleife
  assert.ok(r.speech.length > 0 && r.speech.length < 200, `speech='${r.speech}'`);
});

test('fn: unbekannte Funktion -> null', async () => {
  const r = await renderActionTemplate(`{{ fn('gibtsnicht') }}`, mcp, []);
  assert.equal(r.speech, '');
});

test('index.get ohne Vorwaermen -> Hinweistext statt Crash', async () => {
  const r = await renderActionTemplate(`{{ index.get('light.x') }}`, mcp, []);
  assert.match(r.speech, /Index nicht verfuegbar/);
});

before(async () => {
  createFunction({
    name: 'test_fn_dyn',
    description: null,
    template: `{{ mcp.call('tool_x', {'q': args.x}) }}`,
    parameters: null,
    budget: null,
    inventory_prompt: null,
    enabled: 1,
  });
  createFunction({
    name: 'test_fn_http',
    description: null,
    template: `{{ http('https://api.example.org/' ~ args.path, 0) | dump }}`,
    parameters: null,
    budget: null,
    inventory_prompt: null,
    enabled: 1,
  });
  createFunction({
    name: 'test_fn_ssrf',
    description: null,
    template: `{{ http('http://' ~ args.host ~ '/api', 0) }}`,
    parameters: null,
    budget: null,
    inventory_prompt: null,
    enabled: 1,
  });
  createFunction({
    name: 'test_fn_b',
    description: null,
    template: `{{ fn('test_fn_a') }} B`,
    parameters: null,
    budget: null,
    inventory_prompt: null,
    enabled: 1,
  });
  createFunction({
    name: 'test_fn_a',
    description: null,
    template: `A {{ fn('test_fn_b') }}`,
    parameters: null,
    budget: null,
    inventory_prompt: null,
    enabled: 1,
  });
});
