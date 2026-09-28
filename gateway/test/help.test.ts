// Hilfe deterministisch: je eingerichteter Faehigkeit GENAU eine generische
// Zeile (Werkzeug = Funktion, System = MCP-Server); leer -> nur Grundfunktionen.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb, getDb } from '../src/db/schema.js';
import { createFunction } from '../src/db/functions.js';
import { createMcpServer } from '../src/db/mcpServers.js';
import { installPackage } from '../src/db/packages.js';
import type { PackageManifest } from '../src/core/packages.js';
import { buildHelpSpeech } from '../src/core/help.js';
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

function toolLines(speech: string): string[] {
  return speech.split('\n').filter((l) => l.startsWith('- '));
}

test('leer: nur Grundfunktionen plus Hinweis auf Pakete', () => {
  const speech = buildHelpSpeech();
  assert.match(speech, /keine Fähigkeiten eingerichtet/);
  assert.match(speech, /Pakete/);
  assert.match(speech, /wie heisst du/);
  assert.match(speech, /starte chat modus/);
  assert.doesNotMatch(speech, /Das kann ich aktuell/);
  assert.equal(toolLines(speech).length, 0);
});

test('Funktion mit Notiz erscheint als Werkzeug-Zeile', () => {
  createFunction({
    name: 'wetter',
    description: null,
    template: 'x',
    parameters: null,
    budget: null,
    inventory_prompt: 'Aktuelles Wetter und Vorhersage',
    enabled: 1,
  });
  const speech = buildHelpSpeech();
  assert.match(speech, /Das kann ich aktuell:/);
  assert.match(speech, /Werkzeuge:/);
  assert.match(speech, /- wetter: Aktuelles Wetter und Vorhersage/);
  assert.doesNotMatch(speech, /keine Fähigkeiten eingerichtet/);
});

test('ohne Notiz: Beschreibung, sonst nur der Name (kein Tool fehlt)', () => {
  createFunction({
    name: 'info',
    description: 'Kurzbeschreibung ohne Notiz',
    template: 'x',
    parameters: null,
    budget: null,
    inventory_prompt: null,
    enabled: 1,
  });
  createFunction({
    name: 'stumm',
    description: null,
    template: 'x',
    parameters: null,
    budget: null,
    inventory_prompt: null,
    enabled: 1,
  });
  const speech = buildHelpSpeech();
  assert.match(speech, /- info: Kurzbeschreibung ohne Notiz/);
  assert.match(speech, /- stumm/);
});

test('MCP-Server erscheinen als System-Zeile', () => {
  createMcpServer({
    name: 'home-assistant',
    url: 'https://mcp.example.org/rpc',
    auth_token: null,
    transport: 'http',
    command: null,
    args: null,
    env: null,
    inventory_prompt: 'Smart-Home-Geräte schalten und abfragen',
    enabled: 1,
  });
  const speech = buildHelpSpeech();
  assert.match(speech, /Systeme:/);
  assert.match(speech, /- home-assistant: Smart-Home-Geräte schalten und abfragen/);
});

test('nicht mehr oder weniger: genau eine Zeile je Faehigkeit', () => {
  for (const n of ['a', 'b', 'c']) {
    createFunction({ name: n, description: null, template: 'x', parameters: null, budget: null, inventory_prompt: `${n}-notiz`, enabled: 1 });
  }
  createMcpServer({
    name: 'sys',
    url: 'https://mcp.example.org/rpc',
    auth_token: null,
    transport: 'http',
    command: null,
    args: null,
    env: null,
    inventory_prompt: 'sys-notiz',
    enabled: 1,
  });
  assert.equal(toolLines(buildHelpSpeech()).length, 4);
});

test('deaktivierte Faehigkeiten fehlen in der Hilfe', () => {
  createFunction({ name: 'aus', description: null, template: 'x', parameters: null, budget: null, inventory_prompt: 'sollte fehlen', enabled: 0 });
  assert.doesNotMatch(buildHelpSpeech(), /sollte fehlen/);
});

test('installierte Pakete erweitern die Hilfe (Funktion und System)', () => {
  const weather: PackageManifest = {
    id: 'wetter-paket',
    version: '1.0.0',
    name: 'Wetter',
    summary: 'Wetterdaten',
    description: 'Wetterdaten',
    functions: [{ name: 'wetter', template: 'x', inventory_prompt: 'Aktuelles Wetter und Vorhersage' }],
  };
  const ha: PackageManifest = {
    id: 'ha-paket',
    version: '1.0.0',
    name: 'Home Assistant',
    summary: 'Smart Home',
    description: 'Smart Home',
    servers: [
      {
        name: 'home-assistant',
        transport: 'http',
        url: 'https://mcp.example.org/rpc',
        inventory_prompt: 'Smart-Home-Geräte schalten und abfragen',
        sideEffect: 'read',
      },
    ],
  };
  installPackage(weather, {});
  installPackage(ha, {});
  const speech = buildHelpSpeech();
  assert.match(speech, /- wetter: Aktuelles Wetter und Vorhersage/);
  assert.match(speech, /- home-assistant: Smart-Home-Geräte schalten und abfragen/);
});
