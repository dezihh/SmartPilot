// v0.2.0-Legacy-Bereinigung darf nur EINMAL laufen (Marker in `settings`):
// sonst werden instanzspezifische Reports bei JEDEM Prozessstart geloescht bzw.
// ueberschrieben. Regression fuer v0.2.1 (Datenverlust-Fund).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb, getDb } from '../src/db/schema.js';
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

test('Legacy-Bereinigung laeuft nur einmal und schont spaetere Reports', () => {
  closeDb();
  initDb(DB_PATH, true);

  // Bestands-DB simulieren: Marker entfernen, Legacy-Muster anlegen.
  getDb().prepare('DELETE FROM settings WHERE key = ?').run(CLEANUP_KEY);
  seedLegacyReports();

  // 1. Start: einmalige Bereinigung greift.
  closeDb();
  initDb(DB_PATH, true);
  assert.equal(count("SELECT COUNT(*) c FROM tpl_functions WHERE name = 'boerse_portfolio'"), 0, 'Legacy-Funktion wird beim ersten Lauf entfernt');
  assert.equal(count("SELECT COUNT(*) c FROM actions WHERE name = 'boerse'"), 0, 'Legacy-Vorgang wird beim ersten Lauf entfernt');
  const hs = getDb().prepare("SELECT template FROM tpl_functions WHERE name = 'hausstatus_gw'").get() as { template: string };
  assert.ok(!hs.template.includes('sensor.evcc'), 'hausstatus_gw wird beim ersten Lauf generisch');
  assert.equal(
    (getDb().prepare('SELECT value FROM settings WHERE key = ?').get(CLEANUP_KEY) as { value: string }).value,
    '1',
    'Marker wird in settings gesetzt'
  );

  // Nutzer stellt gleichnamige Reports wieder her.
  seedLegacyReports();

  // 2. Start: darf NICHT mehr aufraeumen (Marker vorhanden).
  closeDb();
  initDb(DB_PATH, true);
  assert.equal(count("SELECT COUNT(*) c FROM tpl_functions WHERE name = 'boerse_portfolio'"), 1, 'Report bleibt nach zweitem Start erhalten');
  assert.equal(count("SELECT COUNT(*) c FROM actions WHERE name = 'boerse'"), 1, 'Vorgang bleibt nach zweitem Start erhalten');
  const hs2 = getDb().prepare("SELECT template FROM tpl_functions WHERE name = 'hausstatus_gw'").get() as { template: string };
  assert.ok(hs2.template.includes('sensor.evcc'), 'hausstatus_gw bleibt nach zweitem Start unveraendert');

  closeDb();
});
