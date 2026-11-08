// Benannte HTTP-Verbindungen: Validierung, Request-Pfad, Maskierung, Paket-
// Installation und das Zusammenspiel mit der bestehenden http_headers-Auth.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { McpContext } from '../src/mcp/registry.js';
import type { TraceEvent } from '../src/types.js';
import type { PackageManifest } from '../src/core/packages.js';

process.env.ADMIN_TOKEN = 'http-connections-admin';
process.env.API_TOKEN = 'http-connections-api';
process.env.LLM_BASE_URL = 'http://127.0.0.1:9/v1';
process.env.LLM_API_KEY = 'http-connections-key';
process.env.LLM_MODEL = 'http-connections-model';

const { tmpDb } = await import('./_tmpdb.js');
const { initDb, closeDb } = await import('../src/db/schema.js');
const {
  createHttpConnection,
  getHttpConnectionByName,
  listHttpConnections,
  getDb,
  setSetting,
  deleteSetting,
  installPackage,
  uninstallPackage,
} = await import('../src/db.js');
const { normalizeHttpConnectionInput, buildConnectionUrl, runConnectionRequest } = await import(
  '../src/core/httpConnections.js'
);
const { fetchUrl } = await import('../src/core/http.js');
const { renderActionTemplate } = await import('../src/core/template.js');

before(() => {
  closeDb();
  initDb(tmpDb('http-connections'));
});

after(() => {
  globalThis.fetch = originalFetch;
  closeDb();
});

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = originalFetch;
  deleteSetting('http_headers');
  deleteSetting('http_private_allow');
  getDb().prepare('DELETE FROM http_connections').run();
});

interface Call {
  url: string;
  init: RequestInit;
}

function stubFetch(body: unknown, status = 200, location?: string): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => (name.toLowerCase() === 'location' ? (location ?? null) : null) },
      body: null,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }) as typeof fetch;
  return calls;
}

const mcp = { servers: [] } as unknown as McpContext;

test('normalizeHttpConnectionInput: private Ziele brauchen allow_private', () => {
  assert.throws(
    () => normalizeHttpConnectionInput({ name: 'lan', base_url: 'http://192.168.10.3:9000' }),
    /allow_private/
  );
  const ok = normalizeHttpConnectionInput({
    name: 'LAN',
    base_url: 'http://192.168.10.3:9000/',
    headers: { 'X-API-Key': 'geheim' },
    allow_private: true,
  });
  assert.equal(ok.name, 'lan');
  assert.equal(ok.base_url, 'http://192.168.10.3:9000');
  assert.equal(ok.allow_private, 1);
  assert.deepEqual(JSON.parse(ok.headers as string), { 'X-API-Key': 'geheim' });
  assert.throws(() => normalizeHttpConnectionInput({ name: 'valid', base_url: 'ftp://example.org' }), /http/);
  assert.throws(() => normalizeHttpConnectionInput({ name: 'valid', base_url: 'https://example.org/?q=1' }), /Query/);
});

test('buildConnectionUrl: Pfad bleibt auf Origin und Prefix', () => {
  assert.equal(buildConnectionUrl('http://h:9000', '/api/x').toString(), 'http://h:9000/api/x');
  assert.equal(buildConnectionUrl('http://h:9000/base', '/api/x').toString(), 'http://h:9000/base/api/x');
  assert.throws(() => buildConnectionUrl('http://h:9000', '//evil/x'), /genau ein/);
  assert.throws(() => buildConnectionUrl('http://h:9000', '/../x'), /\.\./);
});

test('runConnectionRequest: GET sendet Verbindungs-Header', async () => {
  createHttpConnection({
    name: 'svc',
    base_url: 'https://api.example.org',
    headers: '{"X-API-Key":"geheim"}',
    allow_private: 0,
    timeout_ms: null,
    description: null,
    enabled: 1,
  });
  const calls = stubFetch({ ok: true });
  const trace: TraceEvent[] = [];
  assert.deepEqual(await runConnectionRequest('svc', '/v1/x', {}, trace), { ok: true });
  assert.equal(calls[0]!.url, 'https://api.example.org/v1/x');
  assert.equal((calls[0]!.init.headers as Record<string, string>)['X-API-Key'], 'geheim');
  assert.equal(calls[0]!.init.method, 'GET');
  assert.ok(trace.some((e) => e.step === 'template.http.connection'));
});

test('runConnectionRequest: POST mit JSON-Body und Content-Type', async () => {
  createHttpConnection({
    name: 'svc',
    base_url: 'https://api.example.org',
    headers: null,
    allow_private: 0,
    timeout_ms: null,
    description: null,
    enabled: 1,
  });
  const calls = stubFetch({ id: 7 });
  await runConnectionRequest('svc', '/v1/items', { method: 'POST', body: { name: 'x' } }, []);
  assert.equal(calls[0]!.init.method, 'POST');
  assert.equal(calls[0]!.init.body, '{"name":"x"}');
  assert.equal((calls[0]!.init.headers as Record<string, string>)['Content-Type'], 'application/json');
});

test('runConnectionRequest: fremde Redirect-Origin wird blockiert', async () => {
  createHttpConnection({
    name: 'svc',
    base_url: 'https://api.example.org',
    headers: null,
    allow_private: 0,
    timeout_ms: null,
    description: null,
    enabled: 1,
  });
  stubFetch({}, 302, 'https://evil.example/x');
  const trace: TraceEvent[] = [];
  assert.equal(await runConnectionRequest('svc', '/v1/x', {}, trace), null);
  assert.ok(trace.some((e) => e.step === 'template.http.blocked'));
});

test('listHttpConnections maskiert Header, Laufzeitpfad liest sie', () => {
  createHttpConnection({
    name: 'masked',
    base_url: 'https://api.example.org',
    headers: '{"Authorization":"Bearer geheim"}',
    allow_private: 0,
    timeout_ms: null,
    description: null,
    enabled: 1,
  });
  assert.equal(listHttpConnections(false).find((c) => c.name === 'masked')!.headers, null);
  assert.equal(getHttpConnectionByName('masked')!.headers, '{"Authorization":"Bearer geheim"}');
});

test('http(name:/pfad) nutzt die Verbindung, http_headers bleibt unberuehrt', async () => {
  createHttpConnection({
    name: 'svc',
    base_url: 'https://api.example.org',
    headers: '{"X-API-Key":"verbindung"}',
    allow_private: 0,
    timeout_ms: null,
    description: null,
    enabled: 1,
  });
  setSetting('http_headers', '{"api.example.org":{"X-Global":"global"}}');
  const calls = stubFetch({ ok: true });
  const res = await renderActionTemplate("{{ http('svc:/v1/x') | dump }}", mcp, [], {});
  assert.equal(res.speech, '{"ok":true}');
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers['X-API-Key'], 'verbindung');
  assert.equal(headers['X-Global'], undefined);
});

test('http.request: POST-Argumente aus args werden vorab aufgeloest', async () => {
  createHttpConnection({
    name: 'svc',
    base_url: 'https://api.example.org',
    headers: null,
    allow_private: 0,
    timeout_ms: null,
    description: null,
    enabled: 1,
  });
  const calls = stubFetch({ id: 9 });
  const res = await renderActionTemplate(
    "{{ http.request('svc', '/v1/items', { method: 'POST', body: { title: args.title } }) | dump }}",
    mcp,
    [],
    { title: 'Hallo' }
  );
  assert.equal(res.speech, '{"id":9}');
  assert.equal(calls[0]!.init.method, 'POST');
  assert.equal(calls[0]!.init.body, '{"title":"Hallo"}');
});

test('Paket installiert und entfernt eine httpConnection', () => {
  const manifest: PackageManifest = {
    id: 'test-conn-pkg',
    version: '1.0.0',
    name: 'Test',
    summary: 'Test',
    description: 'Test',
    minGatewayVersion: '0.7.0',
    params: [
      { key: 'base_url', label: 'URL', required: true },
      { key: 'api_key', label: 'Key', secret: true, required: true },
    ],
    httpConnections: [
      {
        name: 'pkgconn',
        baseUrl: '${base_url}',
        headers: { 'X-API-Key': '${api_key}' },
        allowPrivate: true,
      },
    ],
    functions: [
      {
        name: 'pkgconn_fn',
        description: 'Test',
        template: "{{ http('pkgconn:/x') | dump }}",
        parameters: { type: 'object', properties: {} },
        sideEffect: 'read',
      },
    ],
  };
  installPackage(manifest, {
    values: { base_url: 'http://192.168.10.3:9000', api_key: 'pkg-secret' },
    dangerousAck: true,
  });
  assert.equal(getHttpConnectionByName('pkgconn')!.headers, '{"X-API-Key":"pkg-secret"}');
  uninstallPackage('test-conn-pkg');
  assert.equal(getHttpConnectionByName('pkgconn'), undefined);
});

test('bestehende http_headers-Auth bleibt fuer rohe URLs aktiv', async () => {
  setSetting('http_headers', '{"api.example.org":{"X-API-Key":"alt"}}');
  const calls = stubFetch({ ok: true });
  assert.deepEqual(await fetchUrl('https://api.example.org/x', [], false), { ok: true });
  assert.equal((calls[0]!.init.headers as Record<string, string>)['X-API-Key'], 'alt');
});
