// Migrationsrunner: Reihenfolge, Rollback bei Fehler, versionierte Bestands-DBs
// (PRAGMA user_version) und automatische Sicherung vor der Migration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations, currentVersion, type Migration } from '../src/db/migrations/runner.js';
import { initDb, closeDb, getSchemaVersion } from '../src/db/schema.js';
import { tmpDb } from './_tmpdb.js';

test('Runner: wendet Migrationen der Reihe nach an, stoppt+rollt bei Fehler zurueck', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE t (id INTEGER)');
  const order: number[] = [];
  const migrations: Migration[] = [
    { version: 1, name: 'a', up: (d) => { order.push(1); d.exec('INSERT INTO t VALUES (1)'); } },
    { version: 2, name: 'b', up: (d) => { order.push(2); d.exec('INSERT INTO t VALUES (2)'); throw new Error('boom'); } },
    { version: 3, name: 'c', up: (d) => { order.push(3); d.exec('INSERT INTO t VALUES (3)'); } },
  ];
  assert.throws(() => runMigrations(db, migrations), /boom/);
  assert.deepEqual(order, [1, 2], 'nach dem Fehler laeuft kein weiterer Schritt');
  assert.equal(currentVersion(db), 1, 'Version bleibt beim letzten erfolgreichen Schritt');
  assert.equal((db.prepare('SELECT COUNT(*) c FROM t').get() as { c: number }).c, 1, 'fehlgeschlagener Schritt zurueckgerollt');
  db.close();
});

test('Runner: onBeforeFirst genau einmal, ohne pending kein Aufruf', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE t (id INTEGER)');
  let n = 0;
  runMigrations(db, [{ version: 1, name: 'a', up: (d) => d.exec('INSERT INTO t VALUES (1)') }], () => { n++; });
  runMigrations(db, [{ version: 1, name: 'a', up: () => {} }], () => { n++; });
  assert.equal(n, 1);
  db.close();
});

test('initDb: frischer Start setzt die Zielversion (kein Backup)', () => {
  const p = tmpDb('mig-fresh');
  closeDb();
  initDb(p);
  assert.equal(getSchemaVersion(), 2);
  assert.equal(existsSync(join(dirname(p), 'backups')), false, 'frische DB ohne Backup');
  closeDb();
});

test('initDb: Bestands-DB wird auf die Zielversion gehoben und gesichert', () => {
  const p = tmpDb('mig-old');
  closeDb();
  initDb(p); // Zielversion erzeugen
  closeDb();
  // Bestands-DB simulieren: Datei existiert, aber Version 1 (Migration 2 steht aus).
  const raw = new Database(p);
  raw.pragma('user_version = 1');
  raw.close();
  initDb(p);
  assert.equal(getSchemaVersion(), 2, 'sequenziell auf Zielversion');
  assert.equal(existsSync(join(dirname(p), 'backups')), true, 'Backup vor Migration angelegt');
  closeDb();
});
