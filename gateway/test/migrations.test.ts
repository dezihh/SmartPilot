// Migrationsrunner: Reihenfolge, Rollback bei Fehler, versionierte Bestands-DBs
// (PRAGMA user_version), automatische Sicherung vor der Migration und der
// v3-Hash-Rebase fuer package_items (npm_spec).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations, currentVersion, type Migration } from '../src/db/migrations/runner.js';
import { initDb, closeDb, getDb, getSchemaVersion, LATEST_SCHEMA_VERSION } from '../src/db/schema.js';
import { conflictItems } from '../src/db/packages.js';
import { hashContent, serverContentOld, serverContentV6 } from '../src/db/itemHash.js';
import { tmpDb } from './_tmpdb.js';

const TARGET = LATEST_SCHEMA_VERSION;

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
  assert.equal(getSchemaVersion(), TARGET);
  assert.equal(existsSync(join(dirname(p), 'backups')), false, 'frische DB ohne Backup');
  closeDb();
});

test('initDb: Bestands-DB wird auf die Zielversion gehoben und gesichert', () => {
  const p = tmpDb('mig-old');
  closeDb();
  initDb(p); // Zielversion erzeugen
  closeDb();
  // Bestands-DB simulieren: Datei existiert, aber Version 1 (Migrationen 2+3 aus).
  const raw = new Database(p);
  raw.pragma('user_version = 1');
  raw.close();
  initDb(p);
  assert.equal(getSchemaVersion(), TARGET, 'sequenziell auf Zielversion');
  assert.equal(existsSync(join(dirname(p), 'backups')), true, 'Backup vor Migration angelegt');
  closeDb();
});

test('Migration 3: rebased Server-Item-Hash, echte lokale Aenderung bleibt Konflikt', () => {
  const p = tmpDb('mig-rebase');
  closeDb();
  initDb(p);
  const db = getDb();
  // Saubere Bestandszeile (v0.2.1-Install, npm_spec NULL) + lokal geaenderte Zeile.
  db.prepare(
    "INSERT INTO mcp_servers (name,url,auth_token,transport,command,args,env,npm_spec,inventory_prompt,side_effect,enabled) VALUES ('Brave','','','stdio','npx','[\"-y\",\"x\"]',NULL,NULL,NULL,'read',1)"
  ).run();
  db.prepare(
    "INSERT INTO mcp_servers (name,url,auth_token,transport,command,args,env,npm_spec,inventory_prompt,side_effect,enabled) VALUES ('Lokal','','','stdio','custom-cmd',NULL,NULL,NULL,NULL,'read',1)"
  ).run();
  const brave = db.prepare("SELECT * FROM mcp_servers WHERE name = 'Brave'").get() as Parameters<typeof serverContentOld>[0];
  const oldHash = hashContent('server', 'Brave', serverContentOld(brave));

  db.prepare("INSERT INTO packages (id, version, source) VALUES ('brave-search', '1.1.1', 'registry')").run();
  db.prepare("INSERT INTO package_items (package_id, kind, name, row_id, content_hash) VALUES ('brave-search','server','Brave',NULL,?)").run(oldHash);
  // Lokal geaenderte Zeile: gespeicherter Hash passt NICHT zur Alt-Form.
  db.prepare("INSERT INTO package_items (package_id, kind, name, row_id, content_hash) VALUES ('brave-search','server','Lokal',NULL,'deadbeefdeadbeef')").run();

  db.pragma('user_version = 2'); // Migration 3 ausstehend
  closeDb();
  initDb(p);

  const conflicts = conflictItems('brave-search');
  assert.equal(conflicts.includes('server:Brave'), false, 'saubere Zeile nach Rebase ohne Konflikt');
  assert.deepEqual(conflicts, ['server:Lokal'], 'lokal geaenderte Zeile bleibt Konflikt');
  closeDb();
});

test('Migration 4: args "[]" wird auf null normalisiert (kein Scheinkonflikt)', () => {
  const p = tmpDb('mig-args');
  closeDb();
  initDb(p);
  const db = getDb();
  // Bestandszeile wie nach alter Admin-UI-Installation: args='[]', Manifest ohne args.
  db.prepare(
    "INSERT INTO mcp_servers (name,url,auth_token,transport,command,args,env,npm_spec,inventory_prompt,side_effect,enabled) VALUES ('SearXNG','','','stdio','node_modules/.bin/mcp-searxng','[]','{\"SEARXNG_URL\":\"http://x\"}',NULL,NULL,'read',1)"
  ).run();
  const row = db.prepare("SELECT * FROM mcp_servers WHERE name = 'SearXNG'").get() as Parameters<typeof serverContentOld>[0];
  const oldHash = hashContent('server', 'SearXNG', serverContentOld(row));
  db.prepare("INSERT INTO packages (id, version, source) VALUES ('searxng', '1.0.2', 'registry')").run();
  db.prepare("INSERT INTO package_items (package_id, kind, name, row_id, content_hash) VALUES ('searxng','server','SearXNG',NULL,?)").run(oldHash);

  db.pragma('user_version = 3'); // Migration 4 ausstehend
  closeDb();
  initDb(p);
  assert.deepEqual(conflictItems('searxng'), [], 'args-Normalisierung verhindert Scheinkonflikt');
  closeDb();
});

test('Migration 6: Bestands-DB (v5) bekommt packages.manifest', () => {
  const p = tmpDb('mig-manifest');
  closeDb();
  initDb(p);
  closeDb();
  // Zustand vor Migration 6 herstellen: Spalte fehlt, Version 5.
  const raw = new Database(p);
  raw.exec('ALTER TABLE packages DROP COLUMN manifest');
  raw.pragma('user_version = 5');
  raw.close();
  initDb(p);
  assert.equal(getSchemaVersion(), TARGET);
  const cols = getDb().prepare('PRAGMA table_info(packages)').all() as { name: string }[];
  assert.ok(cols.some((c) => c.name === 'manifest'), 'manifest-Spalte ergaenzt');
  // Persistenz nutzbar: Manifest schreiben und lesen.
  getDb().prepare("INSERT INTO packages (id, version, manifest) VALUES ('m6', '1.0.0', '{}')").run();
  const row = getDb().prepare("SELECT manifest FROM packages WHERE id = 'm6'").get() as { manifest: string };
  assert.equal(row.manifest, '{}');
  closeDb();
});

test('Migration 7: Header-Hash-Rebase ohne Scheinkonflikt, echte Aenderung bleibt', () => {
  const p = tmpDb('mig-headers');
  closeDb();
  initDb(p);
  const db = getDb();
  db.prepare(
    "INSERT INTO mcp_servers (name,url,transport,headers,side_effect,enabled) VALUES ('Sauber','http://x','http',?,'write',1)"
  ).run(JSON.stringify({ 'X-Api-Key': 'v' }));
  db.prepare(
    "INSERT INTO mcp_servers (name,url,transport,headers,side_effect,enabled) VALUES ('Lokal','http://y','http',?,'write',1)"
  ).run(JSON.stringify({ 'X-Api-Key': 'v' }));
  const clean = db.prepare("SELECT * FROM mcp_servers WHERE name = 'Sauber'").get() as Parameters<typeof serverContentV6>[0];
  const changed = db.prepare("SELECT * FROM mcp_servers WHERE name = 'Lokal'").get() as Parameters<typeof serverContentV6>[0];
  db.prepare("INSERT INTO packages (id, version, source) VALUES ('hdr', '1.0.0', 'registry')").run();
  db.prepare("INSERT INTO package_items (package_id,kind,name,row_id,content_hash) VALUES ('hdr','server','Sauber',NULL,?)").run(
    hashContent('server', 'Sauber', serverContentV6(clean))
  );
  // Lokal geaenderte URL: Alt-Hash passt nicht zur aktuellen Zeile.
  db.prepare("INSERT INTO package_items (package_id,kind,name,row_id,content_hash) VALUES ('hdr','server','Lokal',NULL,?)").run(
    hashContent('server', 'Lokal', { ...serverContentV6(changed), url: 'http://alt' })
  );
  db.pragma('user_version = 6');
  closeDb();
  initDb(p);
  assert.equal(getSchemaVersion(), TARGET);
  assert.deepEqual(conflictItems('hdr'), ['server:Lokal'], 'nur echte Aenderung bleibt Konflikt');
  closeDb();
});

test('Migration 8: actions traegt side_effect/confirm mit verhaltensneutralen Defaults', () => {
  const p = tmpDb('mig-action-security');
  closeDb();
  initDb(p);
  const db = getDb();
  const cols = db.prepare('PRAGMA table_info(actions)').all() as { name: string; dflt_value: string | null }[];
  const side = cols.find((c) => c.name === 'side_effect');
  const confirm = cols.find((c) => c.name === 'confirm');
  assert.ok(side && confirm, 'Spalten fehlen');
  assert.equal(side!.dflt_value, "'write'");
  assert.equal(confirm!.dflt_value, '0');
  db.prepare("INSERT INTO actions (name, mode) VALUES ('def-test', 'llm')").run();
  const row = db.prepare("SELECT side_effect, confirm FROM actions WHERE name = 'def-test'").get() as {
    side_effect: string; confirm: number;
  };
  assert.equal(row.side_effect, 'write');
  assert.equal(row.confirm, 0);
  closeDb();
});

test('Migration 8: Bestands-DB von v7 bekommt die Spalten ohne Datenverlust', () => {
  const p = tmpDb('mig-action-security-v7');
  closeDb();
  initDb(p);
  let db = getDb();
  db.prepare("INSERT INTO actions (name, mode) VALUES ('alt', 'llm')").run();
  db.pragma('user_version = 7');
  closeDb();
  initDb(p);
  db = getDb();
  const row = db.prepare("SELECT side_effect, confirm FROM actions WHERE name = 'alt'").get() as {
    side_effect: string; confirm: number;
  };
  assert.equal(row.side_effect, 'write');
  assert.equal(row.confirm, 0);
  closeDb();
});
