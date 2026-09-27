import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { initDb, closeDb, getDb } from '../src/db/schema.js';
import { setSetting, restoreDefaultSettings } from '../src/db/settings.js';
import { tmpDb } from './_tmpdb.js';

const FRESH_DB = tmpDb('seeds-fresh');

function freshInit(): void {
  closeDb();
  // WAL/SHM mitloeschen: eine alte -wal-Datei kann sonst eine neue .db
  // "rekonstruieren" (SQLite-WAL-Recovery) und laesst Seed-Referenzdaten in
  // hermetische Tests rutschen.
  rmSync(FRESH_DB, { force: true });
  rmSync(FRESH_DB + '-wal', { force: true });
  rmSync(FRESH_DB + '-shm', { force: true });
  initDb(FRESH_DB, true);
}

test('Fresh-Install-Fill: Prompts + Grundeinstellungen-Defaults, sonst nichts', () => {
  freshInit();
  const db = getDb();
  const sys = db.prepare("SELECT content FROM prompts WHERE key = 'agent_system'").get() as { content: string };
  assert.ok(sys.content.includes('AUSSCHLIESSLICH ein JSON-Objekt'), 'agent_system mit JSON-Antwortformat');
  assert.ok(sys.content.includes('keep_open=true nur'), 'keep_open erklaert');
  assert.ok(!sys.content.includes('HassTurnOn') && !sys.content.includes('nordoel'), 'keine Domänen-Zeilen im Basis-Prompt');
  assert.ok(sys.content.includes('{"needs_clarification"'), 'JSON-Antwortformat');
assert.ok(!sys.content.includes('Home Assistant'), 'Seed ohne Systembezug (systemneutral)');
  const inv = db.prepare("SELECT content FROM prompts WHERE key = 'agent_inventory'").get() as { content: string };
  assert.ok(inv.content.includes('{{AGENT_FNS}}'), 'Marker im Inventory-Seed');
  assert.ok(inv.content.includes('Kombinationen'), 'Regeln-Block');
  assert.ok(!inv.content.includes('Musik-Falscherkennungen'), 'Domänen-Regeln liegen bei den Systemen, nicht im Inventory');
  const mt = db.prepare("SELECT value FROM settings WHERE key = 'memory_turns'").get() as { value: string } | undefined;
  const mm = db.prepare("SELECT value FROM settings WHERE key = 'memory_minutes'").get() as { value: string } | undefined;
  assert.equal(mt?.value, '4', 'memory_turns-Default');
  assert.equal(mm?.value, '30', 'memory_minutes-Default');
  // Bewusst NICHT geseedet: Systeme/MCP, Index, Agent-Funktionen, weitere
  // Vorgaenge. Die 2 Basis-Lesetools sind Built-In im Code (core/indexTools.ts).
  // Geseedet wird zusaetzlich die generische Hilfe-Action (Grundausstattung).
  assert.equal((db.prepare('SELECT COUNT(*) n FROM mcp_servers').get() as { n: number }).n, 0, 'keine MCP-Server');
  assert.equal((db.prepare('SELECT COUNT(*) n FROM tpl_functions').get() as { n: number }).n, 0, 'Basis-Lesetools sind Built-In, keine fns geseedet');
  const recherche = db.prepare("SELECT 1 FROM tpl_functions WHERE name = 'recherche'").get();
  assert.ok(!recherche, 'keine Agent-Funktionen geseedet');
  const hilfe = db.prepare("SELECT mode, tools, trigger_phrases, system_prompt FROM actions WHERE name = 'hilfe'").get() as { mode: string; tools: string; trigger_phrases: string; system_prompt: string };
  assert.ok(hilfe, 'generische Hilfe-Action geseedet');
  assert.equal(hilfe.mode, 'llm', 'Hilfe im llm-Modus');
  assert.equal(hilfe.tools, '[]', 'Hilfe bewusst ohne Tools');
  assert.ok(hilfe.trigger_phrases.includes('was kannst du'), 'Hilfe-Trigger vorhanden');
  assert.ok(hilfe.system_prompt.includes('{agent_inventory}'), 'Hilfe-Prompt bindet das Nachschlagewerk ein');
  assert.ok(!hilfe.system_prompt.includes('Hausstatus ("'), 'Hilfe-Prompt ohne feste Domaenen');
  assert.equal((db.prepare('SELECT COUNT(*) n FROM actions').get() as { n: number }).n, 1, 'nur die Hilfe-Action');
  const idx = db.prepare("SELECT value FROM settings WHERE key = 'entity_index'").get() as { value: string } | undefined;
  assert.equal(idx, undefined, 'kein entity_index-Setting');
  closeDb();
});

test('Seed ist idempotent: erneutes Init fuegt nichts hinzu, User-Edits bleiben', () => {
  freshInit();
  getDb().prepare("UPDATE prompts SET content = 'USER-EDIT' WHERE key = 'agent_inventory'").run();
  getDb().prepare("UPDATE actions SET system_prompt = 'USER-HILFE {agent_inventory}' WHERE name = 'hilfe'").run();
  closeDb();
  initDb(FRESH_DB, true); // zweiter Lauf auf existierender DB
  const inv = getDb().prepare("SELECT content FROM prompts WHERE key = 'agent_inventory'").get() as { content: string };
  assert.equal(inv.content, 'USER-EDIT', 'Seed ueberschreibt nicht');
  const hilfe = getDb().prepare("SELECT system_prompt FROM actions WHERE name = 'hilfe'").get() as { system_prompt: string };
  assert.equal(hilfe.system_prompt, 'USER-HILFE {agent_inventory}', 'Hilfe-Edit bleibt erhalten');
  assert.equal((getDb().prepare('SELECT COUNT(*) n FROM actions').get() as { n: number }).n, 1, 'Hilfe wird nicht doppelt angelegt');
  const mt = getDb().prepare("SELECT value FROM settings WHERE key = 'memory_turns'").get() as { value: string };
  assert.equal(mt.value, '4');
  closeDb();
});

test('restoreDefaultSettings: Settings auf Defaults, entity_index unangetastet', () => {
  freshInit();
  setSetting('llm_model', 'user-modell');
  setSetting('memory_turns', '99');
  setSetting('entity_index', 'KEEP-INDEX');
  restoreDefaultSettings();
  const db = getDb();
  const llm = db.prepare("SELECT value FROM settings WHERE key = 'llm_model'").get() as { value: string } | undefined;
  assert.equal(llm, undefined, 'llm_model geloescht (leer = Default)');
  const mt = db.prepare("SELECT value FROM settings WHERE key = 'memory_turns'").get() as { value: string };
  assert.equal(mt.value, '4');
  const idx = db.prepare("SELECT value FROM settings WHERE key = 'entity_index'").get() as { value: string } | undefined;
  assert.equal(idx?.value, 'KEEP-INDEX', 'Index-Konfiguration bleibt');
  closeDb();
});
