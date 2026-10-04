// Die v0.2.0-Legacy-Bereinigung ist jetzt Teil der versionierten Migration 2
// und laeuft damit nur EINMAL (PRAGMA user_version): instanzspezifische Reports
// werden nicht bei jedem Start geloescht/ueberschrieben.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb, getDb, getSchemaVersion } from '../src/db/schema.js';
import { tmpDb } from './_tmpdb.js';

const DB_PATH = tmpDb('legacy-cleanup');
const CLEANUP_KEY = '_legacy_cleanup_v0_2_0';

const count = (sql: string): number => (getDb().prepare(sql).get() as { c: number }).c;

// Legt Reports an, die das alte Referenz-Seed-Muster tragen (wie nach v0.1.8).
function seedLegacyReports(): void {
  const db = getDb();
  db.prepare(
    "INSERT OR REPLACE INTO tpl_functions (name, description, template, side_effect) VALUES ('boerse_portfolio', 'Ghostfolio', ?, 'read')"
  ).run("http('https://h/cgi-bin/gf_holdings.py?x=1')");
  db.prepare(
    "INSERT OR REPLACE INTO actions (name, function_ref) VALUES ('boerse', 'boerse_portfolio')"
  ).run();
  db.prepare(
    "INSERT OR REPLACE INTO tpl_functions (name, description, template, side_effect) VALUES ('hausstatus_gw', 'EVCC-Bericht', ?, 'read')"
  ).run("{{ index.state('sensor.evcc_battery_soc') }}");
}

test('Legacy-Bereinigung laeuft einmalig (Migration) und schont spaetere Reports', () => {
  closeDb();
  initDb(DB_PATH, true);
  assert.equal(getSchemaVersion(), 3, 'frischer Start auf Zielversion');

  // Bestands-DB simulieren: Reparatur-Migration steht noch aus (Version 1),
  // Marker entfernen, Legacy-Muster anlegen.
  getDb().prepare('DELETE FROM settings WHERE key = ?').run(CLEANUP_KEY);
  getDb().pragma('user_version = 1');
  seedLegacyReports();

  // Migration 2 nachziehen: einmalige Bereinigung greift.
  closeDb();
  initDb(DB_PATH, true);
  assert.equal(getSchemaVersion(), 3);
  assert.equal(count("SELECT COUNT(*) c FROM tpl_functions WHERE name = 'boerse_portfolio'"), 0, 'Legacy-Funktion wird entfernt');
  assert.equal(count("SELECT COUNT(*) c FROM actions WHERE name = 'boerse'"), 0, 'Legacy-Vorgang wird entfernt');
  const hs = getDb().prepare("SELECT template FROM tpl_functions WHERE name = 'hausstatus_gw'").get() as { template: string };
  assert.ok(!hs.template.includes('sensor.evcc'), 'hausstatus_gw wird generisch');
  assert.equal(
    (getDb().prepare('SELECT value FROM settings WHERE key = ?').get(CLEANUP_KEY) as { value: string }).value,
    '1',
    'Marker wird in settings gesetzt'
  );

  // Nutzer stellt gleichnamige Reports wieder her.
  seedLegacyReports();

  // Erneuter Start: keine Migration mehr -> Reports bleiben erhalten.
  closeDb();
  initDb(DB_PATH, true);
  assert.equal(count("SELECT COUNT(*) c FROM tpl_functions WHERE name = 'boerse_portfolio'"), 1, 'Report bleibt erhalten');
  assert.equal(count("SELECT COUNT(*) c FROM actions WHERE name = 'boerse'"), 1, 'Vorgang bleibt erhalten');
  const hs2 = getDb().prepare("SELECT template FROM tpl_functions WHERE name = 'hausstatus_gw'").get() as { template: string };
  assert.ok(hs2.template.includes('sensor.evcc'), 'hausstatus_gw bleibt unveraendert');

  closeDb();
});
