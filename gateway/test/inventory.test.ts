import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb, getDb } from '../src/db/schema.js';
import { createFunction } from '../src/db/functions.js';
import { setPrompt, setSetting, deleteSetting } from '../src/db/settings.js';
import { createMcpServer, deleteMcpServer } from '../src/db/mcpServers.js';
import { buildInventoryPrompt } from '../src/core/inventory.js';
import { tmpDb } from './_tmpdb.js';

const DB_PATH = tmpDb('inventory');

const RULES = 'Nimm dieses Nachschlagewerk als Pflicht-Referenz.\n\n- Regel A\n- Regel B';

before(() => {
  closeDb();
  initDb(DB_PATH);
  const db = getDb();
  db.exec('DELETE FROM tpl_functions; DELETE FROM settings; DELETE FROM prompts;');
  setPrompt('agent_inventory', RULES);
  createFunction({
    name: 'recherche',
    description: null,
    template: 'x',
    parameters: null,
    budget: null,
    inventory_prompt: 'Recherche zu jedem Thema: Treffer + URLs',
    enabled: 1,
  });
  createFunction({
    name: 'vorgangs_baustein',
    description: null,
    template: 'x',
    parameters: null,
    budget: null,
    inventory_prompt: null,
    enabled: 1,
  });
  createFunction({
    name: 'ma_players',
    description: null,
    template: 'x',
    parameters: null,
    budget: null,
    inventory_prompt: 'Player-Liste mit State/Vol',
    enabled: 1,
  });
});

after(() => {
  closeDb();
  initDb(DB_PATH);
  getDb().exec("DELETE FROM tpl_functions WHERE name IN ('recherche','vorgangs_baustein','ma_players')");
  closeDb();
});

test('Werkzeug-Zeilen aus inventory_prompt, fn_-Praefix, note-lose fehlen', () => {
  const out = buildInventoryPrompt();
  assert.match(out, /- fn_recherche: Recherche zu jedem Thema/);
  assert.match(out, /- fn_ma_players: Player-Liste/);
  assert.doesNotMatch(out, /fn_vorgangs_baustein/);
  assert.match(out, /- Regel A/);
  assert.match(out, /## Werkzeuge/);
});

test('Regeln bleiben erhalten (kein Zeilenverlust durch Generator)', () => {
  const out = buildInventoryPrompt();
  assert.ok(out.startsWith('Nimm dieses Nachschlagewerk als Pflicht-Referenz.'));
  assert.match(out, /- Regel B/);
});

test('Allowlist filtert Werkzeug-Zeilen (agent_tools)', () => {
  setSetting('agent_tools', 'recherche');
  try {
    const out = buildInventoryPrompt();
    assert.match(out, /fn_recherche/);
    assert.doesNotMatch(out, /fn_ma_players/);
  } finally {
    deleteSetting('agent_tools');
  }
});

test('Allowlist ' + "'keine'" + ' -> Regeln unverändert ohne Werkzeuge', () => {
  setSetting('agent_tools', 'keine');
  try {
    const out = buildInventoryPrompt();
    assert.doesNotMatch(out, /Werkzeuge/);
    assert.match(out, /- Regel A/);
  } finally {
    deleteSetting('agent_tools');
  }
});

test('Systeme-Sektion aus mcp_servers.inventory_prompt (Kaskaden am System)', () => {
  const db = getDb();
  const before = db.prepare('SELECT COUNT(*) AS n FROM mcp_servers').get() as { n: number };
  const server = createMcpServer({
    name: 'Test-System',
    url: 'https://test.example.org/mcp',
    auth_token: null,
    transport: 'http',
    command: null,
    args: null,
    env: null,
    inventory_prompt: 'Schalten: zuerst fn_find_entities, dann ha_call_service (light/turn_on).',
    enabled: 1,
  });
  try {
    const out = buildInventoryPrompt();
    assert.match(out, /## Systeme/);
    assert.match(out, /- Test-System: Schalten: zuerst fn_find_entities/);
    // Werkzeuge vor Systemen
    const idxFns = out.indexOf('## Werkzeuge');
    const idxSys = out.indexOf('## Systeme');
    assert.ok(idxFns < idxSys, 'Werkzeuge zuerst, dann Systeme');
  } finally {
    deleteMcpServer(server.id);
  }
  const after = db.prepare('SELECT COUNT(*) AS n FROM mcp_servers').get() as { n: number };
  assert.equal(after.n, before.n);
});

test('Systeme-Filter: nur Server der aktiven Tool-Liste, [] = ohne Systeme', () => {
  const db = getDb();
  const before = db.prepare('SELECT COUNT(*) AS n FROM mcp_servers').get() as { n: number };
  const server = createMcpServer({
    name: 'Filter-System',
    url: 'https://test.example.org/mcp',
    auth_token: null,
    transport: 'http',
    command: null,
    args: null,
    env: null,
    inventory_prompt: 'Kaskade fuer Filter-System.',
    enabled: 1,
  });
  try {
    // [] (Vorgang ohne Tools): komplette Systeme-Sektion weg
    const none = buildInventoryPrompt([]);
    assert.doesNotMatch(none, /## Systeme/);
    assert.doesNotMatch(none, /Filter-System/);
    // Trefferliste mit anderem Namen: System nicht dabei
    const other = buildInventoryPrompt(['Anderes-System']);
    assert.doesNotMatch(other, /Filter-System/);
    // Trefferliste mit passendem Namen: System dabei
    const hit = buildInventoryPrompt(['Filter-System', 'x']);
    assert.match(hit, /- Filter-System: Kaskade/);
    // null/undefined = alle (wie bisher)
    const all = buildInventoryPrompt();
    assert.match(all, /- Filter-System: Kaskade/);
  } finally {
    deleteMcpServer(server.id);
  }
  const after = db.prepare('SELECT COUNT(*) AS n FROM mcp_servers').get() as { n: number };
  assert.equal(after.n, before.n);
});

test('Markierung {{AGENT_FNS}} wird an Ort und Stelle ersetzt', () => {
  setPrompt('agent_inventory', `Header\n{{AGENT_FNS}}\n\n## Regeln\n- Regel A`);
  try {
    const out = buildInventoryPrompt();
    assert.doesNotMatch(out, /AGENT_FNS/);
    const idxFns = out.indexOf('- fn_recherche');
    const idxRegeln = out.indexOf('## Regeln');
    assert.ok(idxFns > 0 && idxFns < idxRegeln, 'Werkzeuge zwischen Header und Regeln');
    assert.match(out, /## Regeln\n- Regel A/);
  } finally {
    setPrompt('agent_inventory', RULES);
  }
});

test('Leer-Fallback: ohne Werkzeuge/Systeme kein roher {{AGENT_FNS}}-Marker', () => {
  setSetting('agent_tools', 'keine');
  setPrompt('agent_inventory', `Header\n{{AGENT_FNS}}\n\n## Regeln\n- Regel A`);
  try {
    const out = buildInventoryPrompt([]);
    assert.doesNotMatch(out, /AGENT_FNS/);
    assert.match(out, /keine Funktionen oder Systeme eingerichtet/);
    assert.match(out, /## Regeln\n- Regel A/);
  } finally {
    deleteSetting('agent_tools');
    setPrompt('agent_inventory', RULES);
  }
});
