// Regressionstests fuer die Admin-Haertung aus Audit Lauf 2:
// - F-005: die Login-Dateien sind ueber ihre eigenen Routen oeffentlich,
//   die Admin-UI bleibt trotzdem geschuetzt.
// - F-010: /metrics haengt am Admin-Rate-Limiter, aber in einem eigenen
//   Bucket gegenueber der Admin-API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

// config/auth lesen die Umgebung beim Import -> vor den dynamischen Importen setzen.
process.env.ADMIN_TOKEN = 'test-secret';
process.env.API_TOKEN = 'test-query-secret';
process.env.ADMIN_RATE_MAX = '2'; // kleiner Wert, damit 429 testbar ist
process.env.LLM_BASE_URL = 'http://127.0.0.1:9/v1';
process.env.LLM_API_KEY = 'test-key';
process.env.LLM_MODEL = 'test-model';

const { tmpDb } = await import('./_tmpdb.js');
const { initDb, closeDb } = await import('../src/db/schema.js');
const { createApp } = await import('../src/app.js');
const { resetRateLimitsForTests } = await import('../src/rateLimit.js');

closeDb();
initDb(tmpDb('admin-hardening'));

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
}

function get(path: string, opts: { token?: string; accept?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.accept) headers.accept = opts.accept;
    const req = request({ host: '127.0.0.1', port: PORT, method: 'GET', path, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: body }));
    });
    req.on('error', reject);
    req.end();
  });
}

before(() => resetRateLimitsForTests());

test('F-005: Login-Assets bleiben ohne Auth erreichbar', async () => {
  for (const path of ['/admin/login.html', '/admin/css/login.css', '/admin/js/login.js']) {
    const r = await get(path);
    assert.equal(r.status, 200, `${path} muss ohne Session 200 liefern`);
  }
});

test('F-005: die Admin-UI selbst bleibt ohne Auth gesperrt', async () => {
  const r = await get('/admin/');
  assert.equal(r.status, 401);
});

test('F-010: /metrics zaehlt gegen den Admin-Limiter', async () => {
  resetRateLimitsForTests();
  assert.equal((await get('/metrics', { token: 'test-secret' })).status, 200);
  assert.equal((await get('/metrics', { token: 'test-secret' })).status, 200);
  const blocked = await get('/metrics', { token: 'test-secret' });
  assert.equal(blocked.status, 429, 'dritter Abruf bei ADMIN_RATE_MAX=2 muss 429 sein');
});

test('F-010: /metrics und Admin-API teilen sich keinen Bucket', async () => {
  resetRateLimitsForTests();
  // Metrics-Bucket ausschoepfen ...
  await get('/metrics', { token: 'test-secret' });
  await get('/metrics', { token: 'test-secret' });
  assert.equal((await get('/metrics', { token: 'test-secret' })).status, 429);
  // ... die Admin-API hat ihr eigenes Budget und antwortet weiter.
  assert.equal((await get('/admin/api/actions', { token: 'test-secret' })).status, 200);
});
