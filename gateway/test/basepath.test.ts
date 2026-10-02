// Subpath-Support (Issue #10, Ausbaustufe): die Admin-UI laeuft unter BASE_PATH,
// die oeffentliche Adapter-API bleibt auf der Wurzel. Eigene Testdatei, weil
// config die Umgebung beim Import liest (BASE_PATH vor dem dynamischen Import).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { request, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.ADMIN_TOKEN = 'test-secret';
process.env.API_TOKEN = 'test-query-secret';
process.env.LLM_BASE_URL = 'http://127.0.0.1:9/v1';
process.env.LLM_API_KEY = 'test-key';
process.env.LLM_MODEL = 'test-model';
process.env.BASE_PATH = '/smartpilot';

const { tmpDb } = await import('./_tmpdb.js');
const { initDb, closeDb } = await import('../src/db/schema.js');
const { createApp } = await import('../src/app.js');

closeDb();
initDb(tmpDb('basepath'));

const app = createApp();
const server = app.listen(0);
await new Promise<void>((resolve) => server.once('listening', () => resolve()));
const PORT = (server.address() as AddressInfo).port;

after(() => {
  server.close();
  closeDb();
});

interface Res {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
  json: unknown;
}

function call(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string; accept?: string } = {}
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers: Record<string, string> = {};
    if (data) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(data));
    }
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.accept) headers.accept = opts.accept;
    const req = request({ host: '127.0.0.1', port: PORT, method, path, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => {
        let json: unknown = null;
        try {
          json = JSON.parse(body);
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

test('Admin-UI unter BASE_PATH mit Bearer -> 200 (HTML)', async () => {
  const r = await call('GET', '/smartpilot/admin/', { token: 'test-secret' });
  assert.equal(r.status, 200);
  assert.match(String(r.headers['content-type'] ?? ''), /text\/html/);
});

test('Bare /admin-Prefix leitet auf Trailing-Slash um', async () => {
  const r = await call('GET', '/smartpilot/admin', { token: 'test-secret' });
  assert.equal(r.status, 302);
  assert.equal(String(r.headers['location'] ?? ''), '/smartpilot/admin/');
});

test('Trailing-Slash-Redirect erhaelt den Query-String', async () => {
  const r = await call('GET', '/smartpilot/admin?x=1&y=2', { token: 'test-secret' });
  assert.equal(r.status, 302);
  assert.equal(String(r.headers['location'] ?? ''), '/smartpilot/admin/?x=1&y=2');
});

test('Login unter Prefix setzt Cookie-Path=/smartpilot/admin', async () => {
  const r = await call('POST', '/smartpilot/admin/login', { body: { token: 'test-secret' } });
  assert.equal(r.status, 200);
  assert.match(String(r.headers['set-cookie']), /Path=\/smartpilot\/admin/);
});

test('Admin-API unter Prefix: 401 ohne Auth, 200 mit Bearer', async () => {
  const no = await call('GET', '/smartpilot/admin/api/bootstrap');
  assert.equal(no.status, 401);
  const ok = await call('GET', '/smartpilot/admin/api/bootstrap', { token: 'test-secret' });
  assert.equal(ok.status, 200);
});

test('Admin-UI ist auf der Wurzel nicht mehr bedient (/admin/ -> 404)', async () => {
  const r = await call('GET', '/admin/', { token: 'test-secret' });
  assert.equal(r.status, 404);
});

test('Oeffentliche API bleibt auf der Wurzel (/api/query verlangt Auth)', async () => {
  const no = await call('POST', '/api/query', { body: { text: 'hi' } });
  assert.equal(no.status, 401);
});

test('Oeffentliche API bleibt auf der Wurzel: mit API_TOKEN und ohne text -> 400 (Route existiert)', async () => {
  const r = await call('POST', '/api/query', { body: {}, token: 'test-query-secret' });
  assert.equal(r.status, 400);
});

test('Login-Seite unter Prefix ohne Auth -> 200 (HTML)', async () => {
  const r = await call('GET', '/smartpilot/admin/login.html');
  assert.equal(r.status, 200);
  assert.match(String(r.headers['content-type'] ?? ''), /text\/html/);
});

test('Ungeschuetzte HTML-Anfrage wird prefix-korrekt auf Login umgeleitet', async () => {
  const r = await call('GET', '/smartpilot/admin/', { accept: 'text/html' });
  assert.equal(r.status, 302);
  assert.equal(String(r.headers['location'] ?? ''), '/smartpilot/admin/login.html');
});

test('Admin-Alias der Query-API unter Prefix: 401 ohne Auth, 400 mit Auth', async () => {
  const no = await call('POST', '/smartpilot/admin/api/query', { body: {} });
  assert.equal(no.status, 401);
  const ok = await call('POST', '/smartpilot/admin/api/query', { body: {}, token: 'test-secret' });
  assert.equal(ok.status, 400);
});

test('Admin-Alias lambda-trace unter Prefix: 401 ohne Auth, 204 mit Auth', async () => {
  const no = await call('POST', '/smartpilot/admin/api/lambda-trace', { body: {} });
  assert.equal(no.status, 401);
  const ok = await call('POST', '/smartpilot/admin/api/lambda-trace', { body: {}, token: 'test-secret' });
  assert.equal(ok.status, 204);
});
