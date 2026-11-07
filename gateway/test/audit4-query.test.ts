// Query-Route: Laengenlimit und Auth (Audit F-001: Coverage).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.ADMIN_TOKEN = 'test-admin-secret';
process.env.API_TOKEN = 'test-query-secret';
process.env.LLM_BASE_URL = 'http://127.0.0.1:9/v1';
process.env.LLM_API_KEY = 'test-key';
process.env.LLM_MODEL = 'test-model';
process.env.QUERY_MAX_CHARS = '5';
process.env.QUERY_RATE_MAX = '100';

const { tmpDb } = await import('./_tmpdb.js');
const { initDb, closeDb } = await import('../src/db/schema.js');
const { createApp } = await import('../src/app.js');
const { resetRateLimitsForTests } = await import('../src/rateLimit.js');

closeDb();
initDb(tmpDb('audit4-query'));

const app = createApp();
const server = app.listen(0);
await new Promise<void>((resolve) => server.once('listening', () => resolve()));
const PORT = (server.address() as AddressInfo).port;

before(() => resetRateLimitsForTests());
after(() => {
  server.close();
  closeDb();
});

function post(body: unknown, token: string | null = 'test-query-secret'): Promise<number> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: '/api/query',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
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

test('Query: zu langer Text wird mit 413 abgelehnt', async () => {
  assert.equal(await post({ text: 'deutlich zu lang' }), 413);
});

test('Query: leerer Text wird mit 400 abgelehnt', async () => {
  assert.equal(await post({ text: '   ' }), 400);
});

test('Query: fehlendes Token wird mit 401 abgelehnt', async () => {
  assert.equal(await post({ text: 'hi' }, null), 401);
});
