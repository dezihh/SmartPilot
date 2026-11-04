// Migration 2 enthaelt keine instanzspezifische Legacy-Bereinigung mehr:
// Bestandsdaten und Prompt-Texte werden nicht anhand persoenlicher Namen
// geloescht oder ueberschrieben. Der Test sichert dieses Verhalten ab.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb, getDb, getSchemaVersion } from '../src/db/schema.js';
import { tmpDb } from './_tmpdb.js';

const DB_PATH = tmpDb('legacy-cleanup');

const count = (sql: string): number => (getDb().prepare(sql).get() as { c: number }).c;

function seedReports(): void {
  const db = getDb();
  db.prepare(
    "INSERT OR REPLACE INTO tpl_functions (name, description, template, side_effect) VALUES ('example_report', 'Beispielbericht', ?, 'read')",
  ).run("http('https://example.invalid/report')");
  db.prepare("INSERT OR REPLACE INTO actions (name, function_ref) VALUES ('example_action', 'example_report')").run();
  db.prepare(
    "INSERT OR REPLACE INTO tpl_functions (name, description, template, side_effect) VALUES ('example_status', 'Beispielstatus', ?, 'read')",
  ).run("{{ index.state('sensor.example') }}");
}

test('Migration 2 laesst Bestandsdaten unangetastet', () => {
  closeDb();
  initDb(DB_PATH, true);
  assert.equal(getSchemaVersion(), 5, 'frischer Start auf Zielversion');

  const db = getDb();
  db.prepare("DELETE FROM actions WHERE name = 'example_action'").run();
  db.prepare("DELETE FROM tpl_functions WHERE name IN ('example_report', 'example_status')").run();
  seedReports();

  // Migration 2 erneut ausfuehren (Bestands-DB simulieren).
  db.pragma('user_version = 1');
  closeDb();
  initDb(DB_PATH, true);
  assert.equal(getSchemaVersion(), 5);

  assert.equal(count("SELECT COUNT(*) c FROM tpl_functions WHERE name = 'example_report'"), 1, 'Report bleibt erhalten');
  assert.equal(count("SELECT COUNT(*) c FROM actions WHERE name = 'example_action'"), 1, 'Vorgang bleibt erhalten');
  const status = getDb().prepare("SELECT template FROM tpl_functions WHERE name = 'example_status'").get() as { template: string };
  assert.ok(status.template.includes('sensor.example'), 'example_status bleibt unveraendert');

  closeDb();
});
