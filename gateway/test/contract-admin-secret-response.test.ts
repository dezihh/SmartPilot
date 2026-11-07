// Vertragstest: Die Admin-API maskiert Server-Secrets nicht nur in der Liste,
// sondern auch in den Antworten von POST/PUT. Sonst wandern auth_token, env und
// headers nach dem Speichern im Klartext in den Browser.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.ADMIN_TOKEN = 'contract-admin-secret-token';
process.env.API_TOKEN = 'contract-api-secret-token';
process.env.LLM_BASE_URL = 'http://127.0.0.1:9/v1';
process.env.LLM_API_KEY = 'contract-llm-key';
process.env.LLM_MODEL = 'contract-llm-model';

const { tmpDb } = await import('./_tmpdb.js');
const { initDb, closeDb } = await import('../src/db/schema.js');
const { createApp } = await import('../src/app.js');

closeDb();
initDb(tmpDb('contract-admin-secret-response'));

const app = createApp();
const server = app.listen(0);
await new Promise<void>((resolve) => server.once('listening', () => resolve()));
const port = (server.address() as AddressInfo).port;

after(() => {
  server.close();
  closeDb();
});

interface RouteRes {
  status: number;
  json: unknown;
}

function call(method: string, path: string, body: unknown): Promise<RouteRes> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          authorization: `Bearer ${process.env.ADMIN_TOKEN}`,
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(data)),
        },
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (raw += c));
        res.on('end', () => {
          let json: unknown = null;
          try {
            json = JSON.parse(raw) as unknown;
          } catch {
            /* kein JSON */
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

interface ServerPayload {
  server: { id: number; auth_token: string | null; env: string | null; headers: string | null };
}

test(
  'POST /admin/api/mcp-servers maskiert Secrets in der Antwort',
  async () => {
  const res = await call('POST', '/admin/api/mcp-servers', {
    name: 'contract-secret-srv',
    url: '',
    transport: 'stdio',
    command: 'true',
    args: [],
    auth_token: 'streng-geheim',
    env: { SECRET_TOKEN: 'streng-geheim-env' },
    headers: { Authorization: 'Bearer streng-geheim-header' },
  });
  assert.equal(res.status, 200);
  const { server } = res.json as ServerPayload;
  assert.equal(server.auth_token, null, 'auth_token im Klartext in der POST-Antwort');
  assert.equal(server.env, null, 'env im Klartext in der POST-Antwort');
  assert.equal(server.headers, null, 'headers im Klartext in der POST-Antwort');
});

test(
  'PUT /admin/api/mcp-servers/:id maskiert Secrets in der Antwort',
  async () => {
  const created = await call('POST', '/admin/api/mcp-servers', {
    name: 'contract-secret-put',
    url: 'http://127.0.0.1:9/mcp',
    transport: 'http',
    auth_token: 'alt-geheim',
  });
  const id = (created.json as ServerPayload).server.id;

  const res = await call('PUT', `/admin/api/mcp-servers/${id}`, {
    name: 'contract-secret-put',
    url: 'http://127.0.0.1:9/mcp',
    transport: 'http',
    auth_token: 'neu-geheim',
  });
  assert.equal(res.status, 200);
  const { server } = res.json as ServerPayload;
  assert.equal(server.auth_token, null, 'auth_token im Klartext in der PUT-Antwort');
});
