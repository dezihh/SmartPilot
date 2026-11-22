// Beispieldaten beim Erststart: nur bei leerer Datenbank, idempotent,
// abschaltbar und ohne Secrets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tmpDb } from './_tmpdb.js';

// config.ts verlangt Pflicht-Env beim Import.
process.env.ADMIN_TOKEN = 'test-secret';
process.env.API_TOKEN = 'test-query-secret';
process.env.LLM_BASE_URL = 'http://127.0.0.1:9/v1';
process.env.LLM_API_KEY = 'test-key';
process.env.LLM_MODEL = 'test-model';

// Manifest aus dem Repo in ein temporaeres Seed-Verzeichnis legen (so wie es
// im Image unter /app/seed liegt).
const SEED_DIR = mkdtempSync(join(tmpdir(), 'seed-'));
cpSync(
  join(process.cwd(), '..', 'packages', 'de', 'open-meteo-wetter', 'manifest.json'),
  join(SEED_DIR, 'open-meteo-wetter.manifest.json')
);
process.env.SEED_DIR = SEED_DIR;
process.env.SEED_PROFILE = 'example';

const { initDb, closeDb, getDb } = await import('../src/db/schema.js');
const { config } = await import('../src/config.js');
const { seedExample } = await import('../src/db/exampleSeed.js');
const { getSetting } = await import('../src/db/settings.js');

const DB = tmpDb('example-seed');
const SECRET_PATTERNS = [/token/i, /secret/i, /passwor/i, /api[-_]?key/i];

function freshDb(): void {
  closeDb();
  for (const suffix of ['', '-wal', '-shm']) rmSync(DB + suffix, { force: true });
  initDb(DB, true);
}

function actionNames(): string[] {
  const rows = getDb().prepare('SELECT name FROM actions ORDER BY name').all() as { name: string }[];
  return rows.map((r) => r.name);
}

function functionNames(): string[] {
  const rows = getDb().prepare('SELECT name FROM tpl_functions ORDER BY name').all() as { name: string }[];
  return rows.map((r) => r.name);
}

test('Seed legt Wetter-Funktion und beide Beispiel-Vorgaenge an', () => {
  freshDb();
  seedExample();
  assert.ok(functionNames().includes('wetter'), 'Wetter-Funktion aus dem Paket');
  assert.ok(functionNames().includes('laufzeit'), 'Laufzeit-Funktion aus dem Seed');
  // 'hilfe' stammt aus dem Referenz-Seed von initDb(path, true).
  assert.deepEqual(actionNames(), ['Laufzeit', 'Wetter', 'hilfe']);
  const weatherVersion = (JSON.parse(readFileSync(join(SEED_DIR, 'open-meteo-wetter.manifest.json'), 'utf8')) as { version: string }).version;
  assert.equal(getSetting('seed_profile'), `example@${weatherVersion}`);
  // Herkunft fuer die Deinstallation
  const items = getDb().prepare('SELECT id, source FROM packages ORDER BY id').all() as { id: string; source: string }[];
  assert.deepEqual(items.map((i) => i.id), ['open-meteo-wetter', 'seed-starter']);
  assert.deepEqual(new Set(items.map((i) => i.source)), new Set(['seed']));
  closeDb();
});

test('Zweiter Start seedet nicht erneut', () => {
  freshDb();
  seedExample();
  seedExample();
  assert.deepEqual(actionNames(), ['Laufzeit', 'Wetter', 'hilfe']);
  closeDb();
});

test('SEED_PROFILE=none laesst die Installation leer', () => {
  freshDb();
  const original = config.seedProfile;
  Object.assign(config, { seedProfile: 'none' });
  seedExample();
  Object.assign(config, { seedProfile: original });
  assert.deepEqual(actionNames(), ['hilfe']);
  assert.equal(getSetting('seed_profile'), undefined);
  closeDb();
});

test('Ohne Manifest im Seed-Verzeichnis startet der Seed still', () => {
  freshDb();
  const original = process.env.SEED_DIR;
  process.env.SEED_DIR = join(tmpdir(), 'seed-leer-' + Date.now());
  assert.doesNotThrow(() => seedExample());
  assert.deepEqual(actionNames(), ['hilfe']);
  process.env.SEED_DIR = original;
  closeDb();
});

test('Beispieldaten enthalten keine Zugangsdaten', () => {
  freshDb();
  seedExample();
  const dump = JSON.stringify(
    getDb().prepare('SELECT name, template, system_prompt FROM actions').all()
  ) + JSON.stringify(getDb().prepare('SELECT name, template FROM tpl_functions').all());
  for (const pattern of SECRET_PATTERNS) {
    assert.equal(pattern.test(dump), false, `Muster ${pattern} im Seed gefunden`);
  }
  closeDb();
});
