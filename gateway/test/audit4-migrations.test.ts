// Migrationen auf einer Bestands-DB (Audit F-001): applyRepairs und die
// Hash-/Header-Migrationen laufen nur bei Altbestand. Der Test legt eine
// v1-Datenbank mit problematischen Legacy-Daten an und prüft die Reparaturen.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, closeDb, getDb } from '../src/db/schema.js';
import { getSetting, getPrompt } from '../src/db/settings.js';

const dir = mkdtempSync(join(tmpdir(), 'sp-migrations-'));
const DB_PATH = join(dir, 'legacy.db');

before(() => {
  closeDb();
  const legacy = new Database(DB_PATH);
  legacy.exec(`
    PRAGMA user_version = 0;
    CREATE TABLE actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      mode TEXT NOT NULL,
      trigger_phrases TEXT,
      fuzzy_threshold REAL,
      system_prompt TEXT,
      template TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE tpl_functions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      template TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE prompts (key TEXT PRIMARY KEY, content TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
  `);
  legacy.prepare("INSERT INTO settings (key, value) VALUES ('warteton', '1'), ('fastpath_model', 'x'), ('facade_mode', 'alle')").run();
  legacy
    .prepare("INSERT INTO settings (key, value) VALUES ('entity_index', ?)")
    .run(JSON.stringify({ tool: 'ha_eval_template', args: {} }));
  legacy
    .prepare("INSERT INTO actions (name, mode, template) VALUES ('hausstatus', 'deterministic', 'Hallo {{ args.x }}')")
    .run();
  legacy.prepare("INSERT INTO tpl_functions (name, template) VALUES ('ha_find', 'Hallo')").run();
  legacy.prepare("INSERT INTO prompts (key, content) VALUES ('agent_system', 'nutze fn_ha_find'), ('fastpath_system', 'alt')").run();
  legacy.close();
  initDb(DB_PATH);
});

test('Migration: tote Settings werden entfernt', () => {
  assert.equal(getSetting('warteton'), undefined);
  assert.equal(getSetting('fastpath_model'), undefined);
  assert.equal(getSetting('facade_mode'), undefined);
});

test('Migration: HA-DomainHints landen in der Index-Konfiguration', () => {
  const cfg = JSON.parse(getSetting('entity_index') ?? '{}') as { domainHints?: unknown[] };
  assert.ok(Array.isArray(cfg.domainHints) && cfg.domainHints.length > 0);
});

test('Migration: Inline-Template wird zur Funktion', () => {
  const row = getDb().prepare("SELECT function_ref, template FROM actions WHERE name = 'hausstatus'").get() as {
    function_ref: string | null;
    template: string | null;
  };
  assert.equal(row.function_ref, 'hausstatus');
  assert.equal(row.template, null);
});

test('Migration: ha_find wird zu find_entities umbenannt', () => {
  const names = (getDb().prepare('SELECT name FROM tpl_functions').all() as { name: string }[]).map((r) => r.name);
  assert.ok(names.includes('find_entities'));
  assert.equal(names.includes('ha_find'), false);
});

test('Migration: Prompt-Verweise und toter Prompt-Key werden bereinigt', () => {
  assert.match(getPrompt('agent_system') ?? '', /fn_find_entities/);
  assert.equal(getPrompt('fastpath_system'), undefined);
});

test('Migration: Schema-Version steht auf dem Zielstand', () => {
  const version = getDb().pragma('user_version', { simple: true }) as number;
  assert.ok(version >= 7, `user_version=${version}`);
});
