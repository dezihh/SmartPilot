// Hilfe-Katalog (vollstaendig: jede aktive Faehigkeit) + deterministischer
// Fallback/Leer-Text. Der Katalog ist die Erdung fuer die LLM-Formulierung.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb, getDb } from '../src/db/schema.js';
import { createFunction } from '../src/db/functions.js';
import { createMcpServer } from '../src/db/mcpServers.js';
import { installPackage } from '../src/db/packages.js';
import type { PackageManifest } from '../src/core/packages.js';
import { capabilityCatalog, renderHelpCatalog, renderHelpFallback } from '../src/core/help.js';
import { tmpDb } from './_tmpdb.js';

before(() => {
  closeDb();
  initDb(tmpDb('help'));
});

afterEach(() => {
  getDb().exec('DELETE FROM tpl_functions; DELETE FROM mcp_servers; DELETE FROM package_items; DELETE FROM packages;');
});

after(() => {
  closeDb();
});

function fn(name: string, description: string | null, parameters: string | null = null, enabled = 1): void {
  createFunction({ name, description, template: 'x', parameters, budget: null, inventory_prompt: null, enabled });
}

function server(name: string, note: string | null): void {
  createMcpServer({
    name,
    url: 'https://mcp.example.org/rpc',
    auth_token: null,
    transport: 'http',
    command: null,
    args: null,
    env: null,
    inventory_prompt: note,
    enabled: 1,
  });
}

test('Fallback leer: nur Grundfunktionen plus Hinweis auf Pakete', () => {
  const speech = renderHelpFallback();
  assert.match(speech, /keine Fähigkeiten eingerichtet/);
  assert.match(speech, /Pakete/);
  assert.match(speech, /wie heisst du/);
  assert.match(speech, /starte chat modus/);
  assert.doesNotMatch(speech, /Das kann ich aktuell/);
});

test('Katalog: Beschreibung + Parameter je Funktion, ohne inventory_prompt', () => {
  fn('autobahn', 'Stau, Baustellen und Verkehrsmeldungen', JSON.stringify({ type: 'object', properties: { road: { description: 'Autobahn (optional)' } } }));
  const { tools } = capabilityCatalog();
  assert.equal(tools.length, 1);
  assert.equal(tools[0]!.name, 'autobahn');
  assert.match(tools[0]!.text, /Stau, Baustellen und Verkehrsmeldungen/);
  assert.match(tools[0]!.text, /road \(Autobahn \(optional\)\)/);
});

test('Katalog: deaktivierte Faehigkeiten fehlen, Server kommen dazu', () => {
  fn('aus', 'sollte fehlen', null, 0);
  server('home-assistant', 'Smart-Home-Geräte schalten');
  const { tools, systems } = capabilityCatalog();
  assert.equal(tools.length, 0);
  assert.equal(systems.length, 1);
  assert.equal(systems[0]!.name, 'home-assistant');
  assert.match(systems[0]!.text, /Smart-Home-Geräte schalten/);
});

test('renderHelpCatalog: eine Zeile je Faehigkeit, leer -> ""', () => {
  assert.equal(renderHelpCatalog(), '');
  fn('wetter', 'Wetter und Vorhersage');
  server('searxng', 'Websuche');
  const out = renderHelpCatalog();
  assert.match(out, /## Werkzeuge\n- wetter: Wetter und Vorhersage/);
  assert.match(out, /## Systeme\n- searxng: Websuche/);
  assert.equal(out.split('\n').filter((l) => l.startsWith('- ')).length, 2);
});

test('Fallback listet Faehigkeiten generisch (Beschreibung, sonst Name)', () => {
  fn('info', 'Kurzbeschreibung');
  fn('stumm', null);
  const speech = renderHelpFallback();
  assert.match(speech, /Das kann ich aktuell:/);
  assert.match(speech, /- info: Kurzbeschreibung/);
  assert.doesNotMatch(speech, /- stumm:/, 'kein haengender Doppelpunkt ohne Beschreibung');
});

test('Katalog ist groessenbegrenzt (SSML-/Antwortlimit)', () => {
  for (let i = 0; i < 200; i++) fn(`f${i}`, 'x'.repeat(80));
  assert.ok(renderHelpCatalog().length <= 6002);
});

test('Katalog folgt agent_tools (Allowlist)', () => {
  fn('wetter', 'Wetter und Vorhersage');
  fn('autobahn', 'Verkehr');
  assert.equal(capabilityCatalog({ allow: [] }).tools.length, 0);
  assert.deepEqual(
    capabilityCatalog({ allow: ['fn_wetter'] }).tools.map((t) => t.name),
    ['wetter']
  );
});

test('Katalog: Systeme nur soweit nutzbar (servers-Filter)', () => {
  server('a', 'System A');
  server('b', 'System B');
  assert.equal(capabilityCatalog({ servers: [] }).systems.length, 0);
  assert.deepEqual(
    capabilityCatalog({ servers: ['a'] }).systems.map((s) => s.name),
    ['a']
  );
});

test('installierte Pakete erweitern den Katalog (Funktion und System)', () => {
  const weather: PackageManifest = {
    id: 'wetter-paket', version: '1.0.0', name: 'Wetter', summary: 's', description: 'd',
    functions: [{ name: 'wetter', description: 'Wetter und Vorhersage', template: 'x' }],
  };
  const ha: PackageManifest = {
    id: 'ha-paket', version: '1.0.0', name: 'HA', summary: 's', description: 'd',
    servers: [{ name: 'home-assistant', transport: 'http', url: 'https://mcp.example.org/rpc', inventory_prompt: 'Geräte schalten', sideEffect: 'read' }],
  };
  installPackage(weather, {});
  installPackage(ha, {});
  const out = renderHelpCatalog();
  assert.match(out, /- wetter: Wetter und Vorhersage/);
  assert.match(out, /- home-assistant: Geräte schalten/);
});

test('Katalog: parameters ohne properties-Objekt wird ignoriert', () => {
  // parameters als reiner String -> kein Objekt -> keine Parameterangabe.
  fn('s', 'Beschreibung', '"nur-string"');
  const { tools } = capabilityCatalog();
  assert.equal(tools.length, 1);
  assert.equal(tools[0]!.text, 'Beschreibung');
});

test('Katalog: Server ohne inventory_prompt bekommt Platzhalterzeile', () => {
  server('leer', null);
  assert.match(renderHelpCatalog(), /## Systeme\n- leer: \(ohne Beschreibung\)/);
});
