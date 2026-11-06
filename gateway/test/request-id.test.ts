// Anfrage-Kennung (X-Request-ID) und Access-Log: Annahme, Ersetzung,
// Antwortheader und Korrelation der Logzeile.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { request, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LogLevel } from '../src/core/logger.js';

// config/auth lesen die Umgebung beim Import -> vor den dynamischen Importen setzen.
process.env.ADMIN_TOKEN = 'test-secret';
process.env.API_TOKEN = 'test-query-secret';
process.env.LLM_BASE_URL = 'http://127.0.0.1:9/v1';
process.env.LLM_API_KEY = 'test-key';
process.env.LLM_MODEL = 'test-model';

const { tmpDb } = await import('./_tmpdb.js');
const { initDb, closeDb } = await import('../src/db/schema.js');
const { createApp } = await import('../src/app.js');
const { setLogSink, setLogLevel } = await import('../src/core/logger.js');

closeDb();
initDb(tmpDb('request-id'));

const logLines: { line: string; level: LogLevel }[] = [];
setLogSink((line, level) => logLines.push({ line, level }));
setLogLevel('debug');

const app = createApp();
const server = app.listen(0);
await new Promise<void>((resolve) => server.once('listening', () => resolve()));
const PORT = (server.address() as AddressInfo).port;

after(() => {
  server.close();
  closeDb();
  setLogSink(undefined);
});

interface Res {
  status: number;
  headers: IncomingHttpHeaders;
}

function get(path: string, requestId?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (requestId !== undefined) headers['x-request-id'] = requestId;
    const req = request({
      host: '127.0.0.1',
      port: PORT,
      method: 'GET',
      path,
      headers,
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

function waitForLog(predicate: (line: string) => boolean, timeoutMs = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      const found = logLines.map((l) => l.line).find(predicate);
      if (found) return resolve(found);
      if (Date.now() - started > timeoutMs) return reject(new Error('Logzeile nicht gefunden'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

test('uebernimmt eine plausible X-Request-ID und gibt sie zurueck', async () => {
  const res = await get('/healthz', 'test-request-123');
  assert.equal(res.headers['x-request-id'], 'test-request-123');
  const line = await waitForLog((l) => l.includes('req=test-request-123'));
  assert.match(line, /http method=GET path=\/healthz status=200/);
});

test('ersetzt fehlende oder unplausible Kennungen durch eine UUID', async () => {
  for (const given of [undefined, 'kurz', 'x'.repeat(65), 'abc def ghi']) {
    const res = await get('/healthz', given);
    const id = String(res.headers['x-request-id'] ?? '');
    assert.match(id, /^[0-9a-f-]{36}$/, `ungueltig fuer Eingabe ${String(given)}: ${id}`);
    assert.notEqual(id, given);
  }
});

test('verschiedene Anfragen erhalten verschiedene Kennungen', async () => {
  const a = await get('/healthz');
  const b = await get('/healthz');
  assert.notEqual(a.headers['x-request-id'], b.headers['x-request-id']);
});

test('/metrics ohne Token 401, mit Token Prometheus-Text', async () => {
  const anon = await get('/metrics');
  assert.equal(anon.status, 401);

  const authed = await new Promise<{ status: number; text: string; type: string }>((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: PORT, method: 'GET', path: '/metrics', headers: { authorization: `Bearer ${process.env.ADMIN_TOKEN}` } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, text: body, type: String(res.headers['content-type'] ?? '') })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });

  assert.equal(authed.status, 200);
  assert.match(authed.type, /text\/plain/);
  assert.match(authed.text, /smartpilot_http_requests_total\{status="401"/);
  assert.match(authed.text, /smartpilot_uptime_seconds \d+/);
  assert.match(authed.text, /smartpilot_resident_memory_bytes \d+/);
});

test('Access-Log traegt Methode, Pfad, Status und Dauer', async () => {
  const res = await get('/healthz');
  assert.equal(res.status, 200);
  const id = String(res.headers['x-request-id'] ?? '');
  assert.notEqual(id, '');
  const line = await waitForLog((l) => l.includes(`req=${id}`) && l.includes('status=200'));
  assert.match(line, /http method=GET path=\/healthz status=200 ms=\d+$/);
});
