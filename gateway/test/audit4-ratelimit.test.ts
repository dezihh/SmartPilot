// Query-Rate-Limit (Audit F-001: Coverage). Eigene Datei, weil das Limit aus
// der Umgebung nur beim Import gelesen wird.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.ADMIN_TOKEN = 'test-admin-secret';
process.env.API_TOKEN = 'test-query-secret';
process.env.LLM_BASE_URL = 'http://127.0.0.1:9/v1';
process.env.LLM_API_KEY = 'test-key';
process.env.LLM_MODEL = 'test-model';
process.env.QUERY_RATE_MAX = '1';

const { tmpDb } = await import('./_tmpdb.js');
const { initDb, closeDb } = await import('../src/db/schema.js');
const { createApp } = await import('../src/app.js');

closeDb();
initDb(tmpDb('audit4-ratelimit'));

const app = createApp();
const server = app.listen(0);
await new Promise<void>((resolve) => server.once('listening', () => resolve()));
const PORT = (server.address() as AddressInfo).port;

after(() => {
  server.close();
  closeDb();
});

function post(text: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ text });
    const req = request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: '/api/query',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Authorization: 'Bearer test-query-secret',
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

test('Query: Rate-Limit greift ab der zweiten Anfrage', async () => {
  await post('hi');
  assert.equal(await post('hi'), 429);
});
