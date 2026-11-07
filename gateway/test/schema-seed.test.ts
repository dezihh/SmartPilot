// Referenz-Seed: Eine frische Installation bekommt die statischen
// Agent-Prompts und die generische Hilfe-Action. Deckt applyReferenceSeed in
// db/schema.ts ab (bisher ungetestet, weil Tests meist ohne Seed starten).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb, getDb } from '../src/db/schema.js';
import { getPrompt } from '../src/db/settings.js';
import { tmpDb } from './_tmpdb.js';

const DB_PATH = tmpDb('schema-seed');

before(() => {
  closeDb();
  initDb(DB_PATH, true);
});

test('initDb mit Seed legt die Referenz-Prompts an', () => {
  assert.ok((getPrompt('agent_system') ?? '').length > 0, 'agent_system fehlt');
  assert.ok((getPrompt('agent_inventory') ?? '').length > 0, 'agent_inventory fehlt');
});

test('initDb mit Seed legt die Hilfe-Action an', () => {
  const row = getDb()
    .prepare("SELECT mode, tools, enabled FROM actions WHERE name = 'hilfe'")
    .get() as { mode: string; tools: string; enabled: number } | undefined;
  assert.ok(row, 'Hilfe-Action fehlt');
  assert.equal(row.mode, 'llm');
  assert.equal(row.tools, '[]');
  assert.equal(row.enabled, 1);
});
