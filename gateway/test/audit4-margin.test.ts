// Coverage-Puffer (Audit F-001): Session-Auth und Log-Retention.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.ADMIN_TOKEN = 'audit4-admin-token';
process.env.API_TOKEN = 'audit4-api-token';
process.env.LLM_BASE_URL = 'http://127.0.0.1:9/v1';
process.env.LLM_API_KEY = 'test-key';
process.env.LLM_MODEL = 'test-model';

const { tmpDb } = await import('./_tmpdb.js');
const { initDb, closeDb, getDb } = await import('../src/db/schema.js');
const { setSetting, deleteSetting } = await import('../src/db/settings.js');
const { addLog } = await import('../src/db/logs.js');
const { createSession, sessionValid, cookieFor } = await import('../src/auth.js');

const DB_PATH = tmpDb('audit4-margin');

before(() => {
  closeDb();
  initDb(DB_PATH);
});

test('createSession und sessionValid: gueltige Session wird erkannt', () => {
  const id = createSession('audit4-admin-token');
  assert.ok(id, 'Session muss angelegt werden');
  assert.equal(sessionValid({ headers: { cookie: `va_session=${id}` } } as never), true);
  assert.match(cookieFor(id!, true), /Secure/);
});

test('sessionValid: unbekannte Session ist ungueltig', () => {
  assert.equal(sessionValid({ headers: { cookie: 'va_session=unbekannt' } } as never), false);
});

test('addLog: Retention loescht alte Eintraege beim 200. Insert', () => {
  setSetting('log_retention_days', '1');
  try {
    getDb()
      .prepare(
        "INSERT INTO logs (ts, session_id, query, route, response, duration_ms, trace) VALUES (datetime('now','-10 days'), 'alt', 'q', 'agent', '', 0, '[]')",
      )
      .run();
    for (let i = 0; i < 200; i += 1) {
      addLog({ sessionId: `ret-${i}`, query: 'q', route: 'agent', response: '', durationMs: 0, trace: [] });
    }
    const old = getDb().prepare("SELECT COUNT(*) AS n FROM logs WHERE session_id = 'alt'").get() as { n: number };
    assert.equal(old.n, 0, 'alter Eintrag muss entfernt sein');
  } finally {
    deleteSetting('log_retention_days');
  }
});
