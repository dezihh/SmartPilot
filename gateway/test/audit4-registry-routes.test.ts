// Registry-Routen (Admin): Fehlerpfade der Registry-/Manifest-/Install-Routen.
// `fetch` wird gestubbt, damit kein Netz nötig ist (Audit F-001: Coverage).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.ADMIN_TOKEN = 'test-admin-secret';
process.env.API_TOKEN = 'test-query-secret';
process.env.LLM_BASE_URL = 'http://127.0.0.1:9/v1';
process.env.LLM_API_KEY = 'test-key';
process.env.LLM_MODEL = 'test-model';

const { tmpDb } = await import('./_tmpdb.js');
const { initDb, closeDb } = await import('../src/db/schema.js');
const { createApp } = await import('../src/app.js');

closeDb();
initDb(tmpDb('audit4-registry-routes'));

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

function fakeResponse(status: number, text: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => JSON.parse(text),
    headers: { get: () => null },
    body: null,
  } as unknown as Response;
}

function stubFetch(handler: (url: string) => Response): void {
  globalThis.fetch = (async (input: unknown) => handler(String(input))) as typeof fetch;
}

function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = request(
      {
        host: '127.0.0.1',
        port: PORT,
        path,
        method,
        headers: {
          Authorization: 'Bearer test-admin-secret',
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (text += c));
        res.on('end', () => {
          let json: unknown = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = text;
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on('error', reject);
    req.end(payload ?? undefined);
  });
}

const INDEX_JSON = JSON.stringify({
  registryVersion: 1,
  packages: [{ id: 'tmp-pkg', name: 'Temp', summary: 'S', version: '1.0.0' }],
});

const MIN_MANIFEST = {
  id: 'tmp-pkg',
  version: '1.0.0',
  name: 'Temp',
  summary: 'S',
  description: 'D',
};

test('Registry: HTTP-Fehler wird als 400 gemeldet', async () => {
  stubFetch(() => fakeResponse(500, ''));
  assert.equal((await call('GET', '/admin/api/packages/registry')).status, 400);
});

test('Registry: ungueltiges JSON wird als 400 gemeldet', async () => {
  stubFetch(() => fakeResponse(200, '{kaputt'));
  assert.equal((await call('GET', '/admin/api/packages/registry')).status, 400);
});

test('Registry: gueltiger Index wird geliefert', async () => {
  stubFetch(() => fakeResponse(200, INDEX_JSON));
  const res = await call('GET', '/admin/api/packages/registry');
  assert.equal(res.status, 200);
  assert.deepEqual((res.json as { packages: { id: string }[] }).packages.map((p) => p.id), ['tmp-pkg']);
});

test('Manifest: ungueltiges JSON wird als 502 gemeldet', async () => {
  stubFetch((url) => (url.endsWith('index.json') ? fakeResponse(200, INDEX_JSON) : fakeResponse(200, '{kaputt')));
  assert.equal((await call('GET', '/admin/api/packages/manifest/tmp-pkg')).status, 502);
});

test('Manifest: Schemafehler wird als 502 gemeldet', async () => {
  stubFetch((url) =>
    url.endsWith('index.json') ? fakeResponse(200, INDEX_JSON) : fakeResponse(200, JSON.stringify({ id: 'tmp-pkg' })),
  );
  assert.equal((await call('GET', '/admin/api/packages/manifest/tmp-pkg')).status, 502);
});

test('Preview: ungueltiges Manifest wird als 400 gemeldet', async () => {
  assert.equal((await call('POST', '/admin/api/packages/preview', { manifest: {} })).status, 400);
});

test('Preview: gueltiges Manifest wird geliefert', async () => {
  const res = await call('POST', '/admin/api/packages/preview', { manifest: MIN_MANIFEST });
  assert.equal(res.status, 200);
  assert.equal((res.json as { manifest: { id: string } }).manifest.id, 'tmp-pkg');
  // Issue #25: die Vorschau meldet lokale Namenskollisionen (hier keine).
  assert.deepEqual((res.json as { collisions?: string[] }).collisions, []);
});

test('Install: ungueltiges Offline-Manifest wird als 400 gemeldet', async () => {
  assert.equal((await call('POST', '/admin/api/packages/tmp-pkg/install', { manifest: {} })).status, 400);
});

test('Install: zu hohe minGatewayVersion wird abgelehnt', async () => {
  const res = await call('POST', '/admin/api/packages/tmp-pkg/install', {
    manifest: { ...MIN_MANIFEST, minGatewayVersion: '999.0.0' },
  });
  assert.equal(res.status, 400);
  assert.match(String((res.json as { error: string }).error), /Gateway >= 999\.0\.0/);
});

test('Install: Dry-Run liefert einen Bericht', async () => {
  const res = await call('POST', '/admin/api/packages/tmp-pkg/install', {
    manifest: MIN_MANIFEST,
    dryRun: true,
  });
  assert.equal(res.status, 200);
  assert.ok((res.json as { report: unknown }).report);
});

test('Uninstall: unbekanntes Paket wird als 400 gemeldet', async () => {
  assert.equal((await call('POST', '/admin/api/packages/nie-installiert/uninstall')).status, 400);
});
