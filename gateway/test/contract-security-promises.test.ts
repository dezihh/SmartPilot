// Vertragstests fuer Zusagen, die die Oberflaeche und die Doku geben:
// - log_verbatim=0 soll keine Frage/Antwort-Texte speichern.
// - Ein Konfig-Backup enthaelt Tokens nur nach ausdruecklichem Opt-in.
// - Sensible Ziele (Cloud-Metadaten, Loopback) werden in jeder Schreibweise
//   erkannt, auch IPv4-gemappt in IPv6.
//
// Die drei Pruefungen sichern Zusagen ab, die im Full-Audit 2026-11-07 als
// verletzt galten (F-001..F-003). Der Produktivcode ist korrigiert; die Tests
// bleiben als Regressionsschutz scharf.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initDb, closeDb, getDb } from '../src/db/schema.js';
import { setSetting, deleteSetting } from '../src/db/settings.js';
import { addLog } from '../src/db/logs.js';
import { isSensitiveHost } from '../src/core/ssrf.js';
import { tmpDb } from './_tmpdb.js';

const DB_PATH = tmpDb('contract-security-promises');

before(() => {
  closeDb();
  initDb(DB_PATH, true);
  deleteSetting('log_verbatim');
});

test(
  'log_verbatim=0 blankt auch Frage-Texte im Trace',
  () => {
    setSetting('log_verbatim', '0');
    try {
      addLog({
        sessionId: 'contract-privacy',
        query: 'GEHEIME FRAGE',
        route: 'agent',
        response: 'antwort',
        durationMs: 1,
        // So schreibt engine.ts die Nutzerfrage in den Trace (core/engine.ts:416).
        trace: [{ ts: 1, step: 'query', detail: { sessionId: 'contract-privacy', text: 'GEHEIME FRAGE' } }],
      });
      const row = getDb()
        .prepare("SELECT trace FROM logs WHERE session_id = 'contract-privacy'")
        .get() as { trace: string };
      assert.equal(
        row.trace.includes('GEHEIME FRAGE'),
        false,
        'Trace enthaelt die Nutzerfrage trotz log_verbatim=0',
      );
    } finally {
      deleteSetting('log_verbatim');
    }
  },
);

test(
  'isSensitiveHost erkennt IPv4-gemappte Metadata-/Loopback-Ziele',
  () => {
    assert.equal(isSensitiveHost('::ffff:169.254.169.254'), true, 'Cloud-Metadaten in IPv6-Schreibweise');
    assert.equal(isSensitiveHost('[::ffff:127.0.0.1]'), true, 'Loopback in IPv6-Schreibweise');
  },
);

test(
  'Backup-Download schliesst Server-Tokens nicht per Default ein',
  () => {
    const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
    const input = html.match(/<input[^>]*id="backup-with-tokens"[^>]*>/);
    assert.ok(input, 'Checkbox backup-with-tokens fehlt');
    assert.doesNotMatch(input[0], /\bchecked\b/, 'Checkbox fuer Server-Auth-Tokens ist vorbelegt');
  },
);
