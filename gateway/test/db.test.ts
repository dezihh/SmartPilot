import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb, getDb } from '../src/db/schema.js';
import { setSetting, getSetting, getSettingNum, deleteSetting, getSettings, setPrompt, getPrompt, listPrompts } from '../src/db/settings.js';
import { createAction, updateAction, getAction, listActions, deleteAction } from '../src/db/actions.js';
import { createFunction, getFunctionByName, deleteFunction } from '../src/db/functions.js';
import { addLog, listLogs, recentAgentTurns, summarizeUsage } from '../src/db/logs.js';
import Database from 'better-sqlite3';
import { tmpDb } from './_tmpdb.js';

const DB_PATH = tmpDb('smartpilot');

before(() => {
  closeDb(); // hermetisch: Container-DB durch Temp-DB ersetzen
  initDb(DB_PATH, true);
  // Hermetisch: Test-Reststaende entfernen (Datei kann von Vorlaeufen existieren)
  const db = getDb();
  db.exec("DELETE FROM actions WHERE name LIKE 'test_action%'");
  db.exec("DELETE FROM tpl_functions WHERE name LIKE 'test_fn%'");
  db.exec("DELETE FROM logs WHERE session_id = 's1'");
  db.exec("DELETE FROM prompts WHERE key = 'test_prompt'");
});

test('Settings: Upsert + Num-Fallback + Delete', () => {
  setSetting('test_key', '1');
  assert.equal(getSetting('test_key'), '1');
  setSetting('test_key', '2');
  assert.equal(getSetting('test_key'), '2');
  assert.equal(getSettingNum('test_key', 9), 2);
  assert.equal(getSettingNum('existiert_nicht', 9), 9);
  assert.equal(getSettingNum('leer_', 7), 7);
  deleteSetting('test_key');
  assert.equal(getSetting('test_key'), undefined);
});

test('Settings: leerer String zaehlt als nicht gesetzt', () => {
  setSetting('leer_', '');
  assert.equal(getSettingNum('leer_', 7), 7);
  deleteSetting('leer_');
});

test('Prompts: Seed vorhanden + setPrompt ueberschreibt', () => {
  assert.ok(getPrompt('agent_system')?.includes('{assistant_name}'));
  setPrompt('test_prompt', 'abc');
  assert.equal(getPrompt('test_prompt'), 'abc');
  assert.ok(listPrompts().some((p) => p.key === 'test_prompt'));
});

test('Actions: Create/Update/Delete mit normierten Feldern', () => {
  const a = createAction({
    name: 'test_action_x',
    mode: 'hybrid',
    trigger_phrases: JSON.stringify(['test x']),
    fuzzy_threshold: 0.9,
    system_prompt: null,
    template: null,
    function_ref: null,
    function_args: null,
    tools: null,
    enabled: 1,
  });
  assert.ok(a.id > 0);
  assert.deepEqual(a.triggers, ['test x']);
  // tools=null -> toolList=[] (keine Specs, normiert)
  assert.deepEqual(a.toolList, []);

  const upd = updateAction(a.id, {
    name: 'test_action_x',
    mode: 'hybrid',
    trigger_phrases: JSON.stringify(['test y']),
    fuzzy_threshold: null,
    system_prompt: null,
    template: null,
    function_ref: 'fn_x',
    function_args: null,
    tools: '[]',
    enabled: 1,
  });
  assert.deepEqual(upd?.triggers, ['test y']);
  assert.equal(upd?.function_ref, 'fn_x');
  assert.deepEqual(upd?.toolList, []);

  const listed = listActions(true).find((x) => x.id === a.id);
  assert.ok(listed);
  deleteAction(a.id);
  assert.equal(getAction(a.id), undefined);
});

test('Functions: Create + Name-Lookup + Budget', () => {
  const f = createFunction({
    name: 'test_fn_x',
    description: 'Test',
    template: "{{ index.find(args.query) }}",
    parameters: JSON.stringify({ type: 'object', properties: {} }),
    budget: 2,
    inventory_prompt: null,
    enabled: 1,
  });
  const byName = getFunctionByName('test_fn_x');
  assert.equal(byName?.budget, 2);
  assert.deepEqual(byName?.parameters, { type: 'object', properties: {} });
  deleteFunction(f.id);
  assert.equal(getFunctionByName('test_fn_x'), undefined);
});

test('Logs + Usage-Summary + recentAgentTurns', () => {
  const trace = [{ ts: 1, step: 'route.agent' }, { ts: 2, step: 'llm.usage', detail: { model: 'm', prompt_tokens: 10, completion_tokens: 5, cached: false } }];
  addLog({ sessionId: 's1', query: 'frage', route: 'agent', response: 'antwort', durationMs: 100, trace, promptTokens: 10, completionTokens: 5, model: 'm' });
  const logs = listLogs(1) as { query: string; trace: unknown[] }[];
  assert.equal(logs[0]!.query, 'frage');
  assert.equal(logs[0]!.trace.length, 2);

  const usage = summarizeUsage();
  assert.ok(usage.llmRequests >= 1);
  assert.ok(usage.promptTokens >= 10);

  const turns = recentAgentTurns(2, 60 * 60_000);
  assert.ok(turns.some((t) => t.query === 'frage'));
});

// F-26: Migrationen laufen in einer Transaktion. Dieser Test baut eine Alt-DB
// ohne handler_config auf (der Pfad, den ein frischer initDb nie durchlaeuft)
// und prueft, dass die Migration vollstaendig durchlaeuft und Daten erhaelt.
test('Migration: Alt-DB ohne handler_config wird migriert, Daten bleiben erhalten', () => {
  const oldPath = tmpDb('migration');
  const raw = new Database(oldPath);
  raw.exec(`
    CREATE TABLE actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      mode TEXT NOT NULL DEFAULT 'llm',
      trigger_phrases TEXT,
      fuzzy_threshold REAL,
      system_prompt TEXT,
      template TEXT,
      tools TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO actions (name, mode, template) VALUES ('alt_vorgang', 'llm', 'Hallo {{ 1 }}');
  `);
  raw.close();
  closeDb();
  initDb(oldPath, true);
  const cols = (getDb().prepare('PRAGMA table_info(actions)').all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes('handler_config'), 'handler_config muss ergaenzt sein');
  const row = getDb().prepare("SELECT function_ref FROM actions WHERE name = 'alt_vorgang'").get() as
    | { function_ref: string | null }
    | undefined;
  assert.ok(row, 'Alt-Vorgang darf die Migration nicht verlieren');
});
