// Vertrag: `log_verbatim=0` speichert laut doc/CONFIGURATION.md "nur
// Metadaten" - also keine Frage/Antwort-Texte und keinen Trace mit
// Nutzerinhalt. Das muss fuer jede Route gelten, nicht nur fuer `agent`:
// auch ein deterministischer Vorgang enthaelt die Nutzerfrage, und sein Trace
// kann URLs oder Shell-Kommandos aus dem Template tragen.
//
// Befund Audit Lauf 4 (F-02): db/logs.ts wendet die Datenschutz-Reduktion nur
// auf `route === 'agent'` an; `hausstatus` & Co. persistieren weiter Klartext.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb, getDb } from '../src/db/schema.js';
import { addLog } from '../src/db/logs.js';
import { setSetting, deleteSetting } from '../src/db/settings.js';
import { tmpDb } from './_tmpdb.js';

const DB_PATH = tmpDb('contract-log-verbatim');

before(() => {
  closeDb();
  initDb(DB_PATH, true);
  getDb().exec("DELETE FROM logs WHERE session_id LIKE 'verbatim-%'");
});

after(() => {
  deleteSetting('log_verbatim');
  closeDb();
});

function logged(sessionId: string): { query: string; response: string; trace: string } {
  return getDb()
    .prepare('SELECT query, response, trace FROM logs WHERE session_id = ?')
    .get(sessionId) as { query: string; response: string; trace: string };
}

test('log_verbatim=0 blankt Frage und Antwort auch bei einem Vorgang', () => {
  setSetting('log_verbatim', '0');
  try {
    addLog({
      sessionId: 'verbatim-action',
      query: 'GEHEIME FRAGE',
      route: 'hausstatus',
      response: 'GEHEIME ANTWORT',
      durationMs: 1,
      trace: [],
    });
    const row = logged('verbatim-action');
    assert.equal(row.query, '', 'Frage eines Vorgangs wurde trotz log_verbatim=0 gespeichert');
    assert.equal(row.response, '', 'Antwort eines Vorgangs wurde trotz log_verbatim=0 gespeichert');
  } finally {
    deleteSetting('log_verbatim');
  }
});

test('log_verbatim=0 blankt auch Template-Details (URLs/Kommandos) bei einem Vorgang', () => {
  setSetting('log_verbatim', '0');
  try {
    addLog({
      sessionId: 'verbatim-trace',
      query: 'status',
      route: 'hausstatus',
      response: 'ok',
      durationMs: 1,
      trace: [{ ts: 1, step: 'template.shell', detail: { cmd: 'curl http://intern.geheim', chars: 5 } }],
    });
    const row = logged('verbatim-trace');
    assert.equal(
      row.trace.includes('intern.geheim'),
      false,
      'Trace eines Vorgangs enthaelt trotz log_verbatim=0 die interne URL',
    );
  } finally {
    deleteSetting('log_verbatim');
  }
});
