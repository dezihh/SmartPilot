// Vertrag: Eine Paketinstallation darf die globale Tool-Allowlist nicht
// verengen. `agent_tools` ist nicht gesetzt = "alle" (siehe
// core/inventory.ts:agentFnAllowlist). Die Paket-Tools werden deshalb nur dann
// ergaenzt, wenn bereits eine explizite Liste existiert; sonst bleibt die
// Semantik "alle" erhalten.
//
// Befund Audit Lauf 4 (F-01): db/packages.ts behandelt den ungesetzten Wert als
// leere Liste und schreibt nur die Paket-Tools. Ein frisch installiertes
// `aufgabenliste` wuerde damit alle anderen MCP-Tools und Funktionen aus dem
// Agenten-Prompt entfernen.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb, getDb } from '../src/db/schema.js';
import { installPackage, uninstallPackage } from '../src/db/packages.js';
import { getSetting, setSetting, deleteSetting } from '../src/db/settings.js';
import { agentFnAllowlist } from '../src/core/inventory.js';
import { tmpDb } from './_tmpdb.js';

const DB_PATH = tmpDb('contract-package-allowtools');

const MANIFEST = {
  id: 'allowlist-contract',
  version: '1.0.0',
  name: 'Allowlist-Vertrag',
  summary: 'Testpaket fuer die Allowlist-Semantik',
  description: 'Testpaket fuer die Allowlist-Semantik',
  allowTools: ['ha_get_todo', 'ha_set_todo_item'],
  actions: [
    {
      name: 'liste',
      mode: 'llm',
      trigger_phrases: ['liste'],
      system_prompt: 'Test',
      tools: ['ha_get_todo'],
    },
  ],
};

function cleanup(): void {
  try {
    uninstallPackage(MANIFEST.id);
  } catch {
    /* beim ersten Lauf nicht installiert */
  }
  getDb().exec("DELETE FROM packages WHERE id = 'allowlist-contract'");
  getDb().exec("DELETE FROM package_items WHERE package_id = 'allowlist-contract'");
  getDb().exec("DELETE FROM actions WHERE name = 'liste'");
  deleteSetting('agent_tools');
}

before(() => {
  closeDb();
  initDb(DB_PATH, true);
  cleanup();
});

after(() => {
  cleanup();
  closeDb();
});

test('Installation mit ungesetzter agent_tools laesst die Semantik "alle" bestehen', () => {
  deleteSetting('agent_tools');
  assert.equal(agentFnAllowlist(), null, 'Vorbedingung: ungesetzt bedeutet alle Tools');
  try {
    installPackage(MANIFEST as never, { source: 'registry' });
    assert.equal(
      getSetting('agent_tools'),
      undefined,
      'Paket-Installation hat die globale Allowlist auf die Paket-Tools verengt',
    );
    assert.equal(agentFnAllowlist(), null, 'Allowlist muss weiterhin "alle" bedeuten');
  } finally {
    cleanup();
  }
});

test('Installation mit expliziter agent_tools ergaenzt statt zu ersetzen', () => {
  setSetting('agent_tools', 'web_url_read');
  try {
    installPackage(MANIFEST as never, { source: 'registry' });
    const tools = (getSetting('agent_tools') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    assert.ok(tools.includes('web_url_read'), 'bestehende Freigabe bleibt erhalten');
    assert.ok(tools.includes('ha_get_todo'), 'Paket-Tool wird ergaenzt');
    assert.ok(tools.includes('ha_set_todo_item'), 'Paket-Tool wird ergaenzt');
  } finally {
    cleanup();
  }
});
