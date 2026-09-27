// Route-Tests fuer die Express-App (Empfehlung 4). Baut die App ueber
// createApp() ohne listen und spricht sie ueber node:http an, damit
// globalThis.fetch fuer MCP-Stubs frei bleibt.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

// config/auth lesen die Umgebung beim Import -> vor den dynamischen Importen setzen.
process.env.AUTH_TOKEN = 'test-secret';
process.env.LLM_BASE_URL = 'http://127.0.0.1:9/v1';
process.env.LLM_API_KEY = 'test-key';
process.env.LLM_MODEL = 'test-model';

const { tmpDb } = await import('./_tmpdb.js');
const { initDb, closeDb, getDb } = await import('../src/db/schema.js');
const { createApp } = await import('../src/app.js');
const { resetRateLimitsForTests } = await import('../src/rateLimit.js');

closeDb(); // hermetisch: Container-DB durch Temp-DB ersetzen
initDb(tmpDb('routes'));

const app = createApp();
const server = app.listen(0);
await new Promise<void>((resolve) => server.once('listening', () => resolve()));
const PORT = (server.address() as AddressInfo).port;

after(() => {
  server.close();
  closeDb();
});

interface RouteRes {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
  json: unknown;
}

function call(
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string; token?: string } = {}
): Promise<RouteRes> {
  return new Promise((resolve, reject) => {
    const data = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers: Record<string, string> = {};
    if (data) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(data));
    }
    if (opts.cookie) headers.cookie = opts.cookie;
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    const req = request({ host: '127.0.0.1', port: PORT, method, path, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => {
        let json: unknown = null;
        try {
          json = JSON.parse(body) as unknown;
        } catch {
          /* kein JSON */
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text: body, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

let cookie = '';

before(async () => {
  const r = await call('POST', '/admin/login', { body: { token: 'test-secret' } });
  const sc = r.headers['set-cookie'];
  cookie = String(Array.isArray(sc) ? sc[0] : sc).split(';')[0] ?? '';
});

test('ohne Session ist /admin/api/bootstrap 401', async () => {
  const r = await call('GET', '/admin/api/bootstrap');
  assert.equal(r.status, 401);
});

test('login: falsches Token 401, richtiges Token setzt va_session-Cookie', async () => {
  resetRateLimitsForTests();
  const bad = await call('POST', '/admin/login', { body: { token: 'falsch' } });
  assert.equal(bad.status, 401);
  const good = await call('POST', '/admin/login', { body: { token: 'test-secret' } });
  assert.equal(good.status, 200);
  assert.match(String(good.headers['set-cookie']), /va_session=/);
  assert.equal(good.text.includes('va_session'), false, 'Session-ID nicht im Body');
});

test('login: Rate-Limit greift nach zu vielen Versuchen (429)', async () => {
  resetRateLimitsForTests();
  let last = 0;
  for (let i = 0; i < 11; i++) {
    const r = await call('POST', '/admin/login', { body: { token: 'falsch' } });
    last = r.status;
  }
  assert.equal(last, 429);
  resetRateLimitsForTests();
});

test('bootstrap mit Cookie liefert Settings und Actions', async () => {
  const r = await call('GET', '/admin/api/bootstrap', { cookie });
  assert.equal(r.status, 200);
  const j = r.json as { settings: Record<string, string>; actions: unknown[]; servers: unknown[] };
  assert.equal(typeof j.settings, 'object');
  assert.ok(Array.isArray(j.actions));
  assert.ok(Array.isArray(j.servers));
});

test('settings: PUT speichert, fehlendes Objekt ist 400', async () => {
  const ok = await call('PUT', '/admin/api/settings', { cookie, body: { settings: { test_route_key: 'abc' } } });
  assert.equal(ok.status, 200);
  assert.equal((ok.json as { settings: Record<string, string> }).settings.test_route_key, 'abc');
  const bad = await call('PUT', '/admin/api/settings', { cookie, body: {} });
  assert.equal(bad.status, 400);
  const rest = await call('POST', '/admin/api/settings/restore-defaults', { cookie, body: {} });
  assert.equal(rest.status, 200);
});

test('functions: CRUD ueber die Admin-API', async () => {
  const created = await call('POST', '/admin/api/functions', {
    cookie,
    body: { name: 'test_route_fn', template: 'Hallo ' },
  });
  assert.equal(created.status, 200);
  const id = (created.json as { function: { id: number } }).function.id;

  const invalid = await call('POST', '/admin/api/functions', { cookie, body: { name: 'X', template: '' } });
  assert.equal(invalid.status, 400);

  const updated = await call('PUT', `/admin/api/functions/${id}`, {
    cookie,
    body: { name: 'test_route_fn', template: 'Hallo 2' },
  });
  assert.equal(updated.status, 200);

  const list = await call('GET', '/admin/api/functions', { cookie });
  assert.ok(Array.isArray((list.json as { functions: unknown[] }).functions));

  const del = await call('DELETE', `/admin/api/functions/${id}`, { cookie });
  assert.equal(del.status, 200);
});

test('actions: CRUD + Validierung ueber die Admin-API', async () => {
  const created = await call('POST', '/admin/api/actions', {
    cookie,
    body: { name: 'test_route_action', mode: 'llm', trigger_phrases: '["test phrase"]', template: 'Hi' },
  });
  assert.equal(created.status, 200);
  const id = (created.json as { action: { id: number } }).action.id;

  const invalid = await call('POST', '/admin/api/actions', { cookie, body: { name: 'x', mode: 'bogus' } });
  assert.equal(invalid.status, 400);

  const updated = await call('PUT', `/admin/api/actions/${id}`, { cookie, body: { name: 'test_route_action', mode: 'llm' } });
  assert.equal(updated.status, 200);

  const del = await call('DELETE', `/admin/api/actions/${id}`, { cookie });
  assert.equal(del.status, 200);
});

test('indexes: GET liefert konfigurierte Quellen', async () => {
  const r = await call('GET', '/admin/api/indexes', { cookie });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray((r.json as { indexes: unknown[] }).indexes));
});

test('mcp-servers: CRUD, Maskierung und env-COALESCE', async () => {
  const created = await call('POST', '/admin/api/mcp-servers', {
    cookie,
    body: {
      name: 'route-srv',
      url: 'http://127.0.0.1:9/x',
      auth_token: 'geheim',
      transport: 'stdio',
      command: 'true',
      args: [],
      env: 'K=v',
    },
  });
  assert.equal(created.status, 200);
  const id = (created.json as { server: { id: number } }).server.id;

  const list = await call('GET', '/admin/api/mcp-servers', { cookie });
  const row = (list.json as { servers: { name: string; auth_token: string | null; env: string | null }[] }).servers.find(
    (s) => s.name === 'route-srv'
  );
  assert.ok(row);
  assert.equal(row.auth_token, null);
  assert.equal(row.env, null);

  // PUT ohne env laesst den Wert unveraendert (COALESCE, F-34).
  const put = await call('PUT', `/admin/api/mcp-servers/${id}`, {
    cookie,
    body: { name: 'route-srv', url: 'http://127.0.0.1:9/x', auth_token: 'neu', transport: 'stdio', command: 'true', args: [] },
  });
  assert.equal(put.status, 200);
  const dbRow = getDb().prepare('SELECT env FROM mcp_servers WHERE id = ?').get(id) as { env: string | null };
  assert.equal(dbRow.env, '{"K":"v"}');

  const health = await call('POST', '/admin/api/mcp-servers/999999/health', { cookie, body: {} });
  assert.equal(health.status, 404);

  const del = await call('DELETE', `/admin/api/mcp-servers/${id}`, { cookie });
  assert.equal(del.status, 200);
});

test('tools: GET liefert MCP- und Funktions-Fassade', async () => {
  const r = await call('GET', '/admin/api/tools', { cookie });
  assert.equal(r.status, 200);
  const j = r.json as { mcp: unknown[]; functions: unknown[] };
  assert.ok(Array.isArray(j.mcp));
  assert.ok(Array.isArray(j.functions));
});

test('logs und usage sind lesbar', async () => {
  const logs = await call('GET', '/admin/api/logs', { cookie });
  assert.equal(logs.status, 200);
  const usage = await call('GET', '/admin/api/usage', { cookie });
  assert.equal(usage.status, 200);
});

test('lambda-trace: POST quittiert mit 204', async () => {
  const r = await call('POST', '/api/lambda-trace', { cookie, body: { sessionId: 's1', event: 'test', elapsedMs: 5 } });
  assert.equal(r.status, 204);
});

test('query: fehlender text 400, ohne Session 401', async () => {
  const bad = await call('POST', '/api/query', { cookie, body: {} });
  assert.equal(bad.status, 400);
  const noAuth = await call('POST', '/admin/api/query', { body: { text: 'hallo' } });
  assert.equal(noAuth.status, 401);
});
