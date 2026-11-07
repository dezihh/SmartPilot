// Coverage für Konfigurationspfade (Audit F-001): Index-Config-Parsing,
// Manifest-Validierung/Semver und das Löschen eines MCP-Servers.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb } from '../src/db/schema.js';
import { setSetting, deleteSetting } from '../src/db/settings.js';
import { findInSnapshot } from '../src/core/indexTools.js';
import {
  validateManifest,
  compareSemver,
  meetsMinVersion,
  manifestDangerous,
} from '../src/core/packages.js';
import { createMcpServer, deleteMcpServer, getMcpServer } from '../src/db/mcpServers.js';
import type { IndexEntry } from '../src/core/entityIndex.js';
import { tmpDb } from './_tmpdb.js';

const DB_PATH = tmpDb('audit4-config');

before(() => {
  closeDb();
  initDb(DB_PATH);
});

const ENTRY: IndexEntry = {
  id: 'sensor.a',
  name: 'Lampe',
  state: 'on',
  unit: '',
  area: '',
  attributes: {},
};

const OK_MANIFEST = {
  id: 'tmp-pkg',
  version: '1.0.0',
  name: 'Temp',
  summary: 'S',
  description: 'D',
};

test('Index-Config: ungueltiges JSON faellt auf Defaults zurueck', () => {
  setSetting('entity_index_bad', '{kaputt');
  try {
    assert.equal(typeof findInSnapshot([ENTRY], 'lampe', 8, 'bad'), 'string');
  } finally {
    deleteSetting('entity_index_bad');
  }
});

test('Index-Config: Alt-Format template wird als args.template uebernommen', () => {
  setSetting('entity_index_alt', JSON.stringify({ tool: 't', template: 'X' }));
  try {
    assert.ok(findInSnapshot([ENTRY], 'lampe', 8, 'alt').includes('sensor.a'));
  } finally {
    deleteSetting('entity_index_alt');
  }
});

test('Index-Config: Alias, DomainHints und Stopwords werden uebernommen', () => {
  setSetting(
    'entity_index_cfg',
    JSON.stringify({
      tool: 't',
      args: {},
      aliases: { lampe: 'licht' },
      domainHints: [{ re: 'licht', domains: ['light'] }],
      stopwords: ['bitte'],
    }),
  );
  try {
    const hit = findInSnapshot([{ ...ENTRY, id: 'light.a', name: 'Licht' }], 'lampe', 8, 'cfg');
    assert.ok(hit.includes('light.a'), 'Alias lampe->licht muss treffen');
    // Zweiter Aufruf nutzt den Config-Cache (gleicher Rohtext).
    assert.ok(findInSnapshot([{ ...ENTRY, id: 'light.a', name: 'Licht' }], 'lampe', 8, 'cfg').includes('light.a'));
  } finally {
    deleteSetting('entity_index_cfg');
  }
});

test('validateManifest: gueltiges Minimal-Manifest', () => {
  assert.equal(validateManifest(OK_MANIFEST).ok, true);
});

test('validateManifest: fehlende oder ungueltige Pflichtfelder', () => {
  assert.equal(validateManifest(null).ok, false);
  assert.equal(validateManifest({}).ok, false);
  assert.equal(validateManifest({ ...OK_MANIFEST, id: 'BAD!' }).ok, false);
  assert.equal(validateManifest({ ...OK_MANIFEST, version: '1.0' }).ok, false);
});

test('validateManifest: Parameter- und Server-Fehler', () => {
  assert.equal(validateManifest({ ...OK_MANIFEST, params: [{ key: 'BAD KEY', label: 'L' }] }).ok, false);
  assert.equal(validateManifest({ ...OK_MANIFEST, servers: [{ name: 'S', transport: 'http' }] }).ok, false);
  assert.equal(validateManifest({ ...OK_MANIFEST, servers: [{ name: 'S', transport: 'stdio' }] }).ok, false);
});

test('validateManifest: Funktions-, Action- und allowTools-Fehler', () => {
  assert.equal(validateManifest({ ...OK_MANIFEST, functions: [{ name: 'BAD!' }] }).ok, false);
  assert.equal(validateManifest({ ...OK_MANIFEST, actions: [{ name: 'BAD!', mode: 'llm' }] }).ok, false);
  assert.equal(validateManifest({ ...OK_MANIFEST, actions: [{ name: 'ok', mode: 'kaputt' }] }).ok, false);
  assert.equal(validateManifest({ ...OK_MANIFEST, allowTools: ['BAD!'] }).ok, false);
});

test('compareSemver und meetsMinVersion', () => {
  assert.equal(compareSemver('1.2.3', '1.2.3'), 0);
  assert.equal(compareSemver('1.2.3', '1.2.4'), -1);
  assert.equal(compareSemver('2.0.0', '1.9.9'), 1);
  assert.equal(meetsMinVersion('1.0.0', undefined), true);
  assert.equal(meetsMinVersion('1.0.0', '1.0.0'), true);
  assert.equal(meetsMinVersion('0.9.0', '1.0.0'), false);
});

test('manifestDangerous: stdio-Server gilt als gefaehrlich', () => {
  const danger = manifestDangerous({
    ...OK_MANIFEST,
    servers: [{ name: 'S', transport: 'stdio', command: 'node' }],
  } as never);
  assert.equal(danger.dangerous, true);
  assert.ok(danger.items.some((i) => i.includes('stdio')));
});

test('mcpServers: delete entfernt den Eintrag', () => {
  const row = createMcpServer({
    name: 'audit4-tmp-del',
    url: 'https://example.org',
    auth_token: null,
    transport: 'http',
    command: null,
    args: null,
    env: null,
    inventory_prompt: null,
    enabled: 1,
  });
  deleteMcpServer(row.id);
  assert.equal(getMcpServer(row.id), undefined);
});
