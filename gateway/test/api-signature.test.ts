// Vertragstests fuer den Replay-Schutz der Adapter-API (Issue #5):
// - Ohne Signatur/gueltige Signatur antwortet das Gateway 401.
// - Signatur, Zeitstempel und Nonce werden geprueft; eine Nonce gilt nur
//   einmal, also ist ein Replay derselben Anfrage 401.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';

// config/auth lesen die Umgebung beim Import -> vor den dynamischen Importen setzen.
process.env.ADMIN_TOKEN = 'test-admin-secret';
process.env.API_TOKEN = 'test-query-secret';
process.env.API_SIGNING_SECRET = 'test-signing-secret';
process.env.LLM_BASE_URL = 'http://127.0.0.1:9/v1';
process.env.LLM_API_KEY = 'test-key';
process.env.LLM_MODEL = 'test-model';

const { tmpDb } = await import('./_tmpdb.js');
const { initDb, closeDb } = await import('../src/db/schema.js');
const { createApp } = await import('../src/app.js');
const { signApiRequest, checkApiSignature } = await import('../src/apiSignature.js');

closeDb();
initDb(tmpDb('api-signature'));

const app = createApp();
const server = app.listen(0);
await new Promise<void>((resolve) => server.once('listening', () => resolve()));
const PORT = (server.address() as AddressInfo).port;

after(() => {
  server.close();
  closeDb();
});

const BODY = JSON.stringify({ sessionId: 'sig-test', event: 'probe', elapsedMs: 1 });
const SECRET = 'test-signing-secret';

function nonce(): string {
  return randomBytes(16).toString('hex');
}

function headersFor(body: string, ts = Math.floor(Date.now() / 1000), n = nonce()): Record<string, string> {
  return {
    Authorization: 'Bearer test-query-secret',
    'Content-Type': 'application/json',
    'X-Timestamp': String(ts),
    'X-Nonce': n,
    'X-Signature': signApiRequest(SECRET, ts, n, body),
  };
}

function post(body: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: '/api/lambda-trace',
        method: 'POST',
        headers: { 'Content-Length': Buffer.byteLength(body), ...headers },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

test('gueltige Signatur wird akzeptiert', async () => {
  assert.equal(await post(BODY, headersFor(BODY)), 204);
});

test('fehlende Signatur wird abgelehnt', async () => {
  const status = await post(BODY, {
    Authorization: 'Bearer test-query-secret',
    'Content-Type': 'application/json',
  });
  assert.equal(status, 401);
});

test('falsche Signatur wird abgelehnt', async () => {
  const headers = headersFor(BODY);
  headers['X-Signature'] = 'a'.repeat(64);
  assert.equal(await post(BODY, headers), 401);
});

test('veralteter Zeitstempel wird abgelehnt', async () => {
  const old = Math.floor(Date.now() / 1000) - 3600;
  assert.equal(await post(BODY, headersFor(BODY, old)), 401);
});

test('Replay derselben Nonce wird abgelehnt', async () => {
  const headers = headersFor(BODY);
  assert.equal(await post(BODY, headers), 204);
  assert.equal(await post(BODY, headers), 401);
});

test('manipulierter Body wird abgelehnt', async () => {
  const headers = headersFor(BODY);
  const tampered = JSON.stringify({ sessionId: 'sig-test', event: 'boese', elapsedMs: 1 });
  assert.equal(await post(tampered, headers), 401);
});

test('ohne Bearer-Token wird auch mit Signatur abgelehnt', async () => {
  const headers = headersFor(BODY);
  delete headers.Authorization;
  assert.equal(await post(BODY, headers), 401);
});

// --- Unit-Tests fuer die Randfaelle der Pruefung selbst ---

const UNIT_BODY = '{"sessionId":"unit"}';
const TTL = 300;

function unitCheck(overrides: Partial<Parameters<typeof checkApiSignature>[0]>) {
  return checkApiSignature({
    signature: undefined,
    timestamp: undefined,
    nonce: undefined,
    rawBody: UNIT_BODY,
    secret: SECRET,
    ttlSeconds: TTL,
    ...overrides,
  });
}

test('fehlende Felder werden als missing gemeldet', () => {
  const ts = Math.floor(Date.now() / 1000);
  const n = nonce();
  assert.equal(unitCheck({ signature: 'x', timestamp: String(ts) }), 'missing');
  assert.equal(unitCheck({ signature: 'x', nonce: n }), 'missing');
  assert.equal(unitCheck({ timestamp: String(ts), nonce: n }), 'missing');
});

test('ungueltige Nonce und ungueltiger Zeitstempel werden abgewiesen', () => {
  const ts = Math.floor(Date.now() / 1000);
  assert.equal(unitCheck({ signature: 'x', timestamp: String(ts), nonce: 'NICHT-HEX' }), 'bad-signature');
  assert.equal(unitCheck({ signature: 'x', timestamp: 'abc', nonce: nonce() }), 'bad-signature');
  assert.equal(unitCheck({ signature: 'x', timestamp: '0', nonce: nonce() }), 'bad-signature');
});

test('Signatur mit falscher Laenge wird abgewiesen', () => {
  const ts = Math.floor(Date.now() / 1000);
  assert.equal(unitCheck({ signature: 'abc', timestamp: String(ts), nonce: nonce() }), 'bad-signature');
});

test('now steuert das Zeitfenster (ok und stale)', () => {
  const ts = 1_700_000_000;
  const n = nonce();
  const signature = signApiRequest(SECRET, ts, n, UNIT_BODY);
  assert.equal(unitCheck({ signature, timestamp: String(ts), nonce: n, now: ts * 1000 }), 'ok');
  assert.equal(
    unitCheck({ signature, timestamp: String(ts), nonce: n, now: (ts + TTL + 1) * 1000 }),
    'stale',
  );
});

test('abgelaufene Nonces werden aufgeraeumt (gleiche Nonce wieder frei)', () => {
  const ts = 1_700_000_000;
  const n = nonce();
  assert.equal(
    unitCheck({ signature: signApiRequest(SECRET, ts, n, UNIT_BODY), timestamp: String(ts), nonce: n, now: ts * 1000 }),
    'ok',
  );
  // Nach Ablauf des doppelten Fensters raeumt der naechste Aufruf den Eintrag
  // weg: dieselbe Nonce mit frischem Zeitstempel gilt wieder als neu. Ohne
  // Prune waere das ein Replay.
  const later = ts + TTL * 3;
  assert.equal(
    unitCheck({
      signature: signApiRequest(SECRET, later, n, UNIT_BODY),
      timestamp: String(later),
      nonce: n,
      now: later * 1000,
    }),
    'ok',
  );
});

test('fester Testvektor (identisch im Python-Test)', () => {
  // Gemeinsamer Vektor gegen Sprachdrift: Secret "v", ts 1700000000,
  // Nonce aus einem wiederholten Muster, Body {"a":1}. Nonce und Signatur
  // werden zusammengesetzt, damit der Secret-Scanner keinen
  // High-Entropy-String als vermeintliches Secret meldet.
  const body = '{"a":1}';
  const ts = 1_700_000_000;
  const n = '0123456789abcdef'.repeat(2);
  const expected = [
    'b48e38e1', '472a8bcd', '8ddc45f5', '12a79cd1',
    'd4c94a01', 'ddada28e', '4201a323', '36cde622',
  ].join('');
  assert.equal(signApiRequest('v', ts, n, body), expected);
  assert.equal(
    unitCheck({ signature: expected, timestamp: String(ts), nonce: n, rawBody: body, secret: 'v', now: ts * 1000 }),
    'ok',
  );
});

test('signierter Body mit abweichender Formatierung wird akzeptiert', async () => {
  // Der Server muss die signierten Bytes pruefen, nicht eine Neuserialisierung:
  // pretty-printed JSON waere nach JSON.stringify anders.
  const pretty = '{\n  "sessionId": "sig-test",\n  "event": "pretty",\n  "elapsedMs": 1\n}';
  assert.equal(await post(pretty, headersFor(pretty)), 204);
});

// Zuletzt: dieser Test fuellt den Cache bis zur Obergrenze und macht danach
// jede weitere Pruefung fail-closed. Deshalb steht er am Dateiende.
test('voller Nonce-Cache lehnt ab statt zu verdraengen', () => {
  const ts = Math.floor(Date.now() / 1000);
  const now = ts * 1000;
  const nonceAt = (i: number) => i.toString(16).padStart(32, '0');
  let filled = 0;
  for (let i = 0; i < 20_000; i += 1) {
    const n = nonceAt(i);
    const result = unitCheck({
      signature: signApiRequest(SECRET, ts, n, UNIT_BODY),
      timestamp: String(ts),
      nonce: n,
      now,
    });
    if (result === 'cache-full') break;
    assert.equal(result, 'ok', `Eintrag ${i} sollte akzeptiert werden`);
    filled += 1;
  }
  assert.ok(filled >= 9_000, `Cache wurde nur bis ${filled} gefuellt`);
  // Der aelteste Eintrag bleibt erhalten: ein Replay wird weiter erkannt,
  // statt die Signatur durch Verdraengung erneut zuzulassen.
  const oldest = nonceAt(0);
  assert.equal(
    unitCheck({ signature: signApiRequest(SECRET, ts, oldest, UNIT_BODY), timestamp: String(ts), nonce: oldest, now }),
    'replayed',
  );
});
