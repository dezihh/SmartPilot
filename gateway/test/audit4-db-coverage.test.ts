// Deckt die in Lauf 4 ungetesteten Zweige der DB-Schicht und von ssrf ab:
// Reveal-Pfad, optionale Felder beim Anlegen, clearSecrets beim Update und
// die Ungueltig-Kurzform von isPrivateHost.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb } from '../src/db/schema.js';
import {
  createMcpServer,
  deleteMcpServer,
  getMcpServer,
  listMcpServers,
  updateMcpServer,
} from '../src/db/mcpServers.js';
import { isPrivateHost } from '../src/core/ssrf.js';
import { tmpDb } from './_tmpdb.js';

const DB_PATH = tmpDb('audit4-db-coverage');

before(() => {
  closeDb();
  initDb(DB_PATH);
});

after(() => {
  closeDb();
});

test('listMcpServers: ohne enabledOnly listet auch deaktivierte Server', () => {
  const a = createMcpServer({
    name: 'coverage-aktiv',
    url: 'https://mcp.example.org/rpc',
    auth_token: null,
    transport: 'http',
    command: null,
    args: null,
    env: null,
    inventory_prompt: null,
    enabled: 1,
  });
  const b = createMcpServer({
    name: 'coverage-aus',
    url: 'https://mcp.example.org/rpc2',
    auth_token: null,
    transport: 'http',
    command: null,
    args: null,
    env: null,
    inventory_prompt: null,
    enabled: 0,
  });
  try {
    const alle = listMcpServers(false).map((r) => r.id);
    assert.ok(alle.includes(a.id) && alle.includes(b.id), 'beide Server sichtbar');
    const nurAktiv = listMcpServers(true).map((r) => r.id);
    assert.ok(nurAktiv.includes(a.id));
    assert.equal(nurAktiv.includes(b.id), false, 'deaktivierter Server fehlt');
  } finally {
    deleteMcpServer(a.id);
    deleteMcpServer(b.id);
  }
});

test('listMcpServers: reveal=true liefert die Secrets im Klartext', () => {
  const row = createMcpServer({
    name: 'coverage-secrets',
    url: 'https://mcp.example.org/rpc3',
    auth_token: 'token-abc',
    transport: 'http',
    command: null,
    args: null,
    env: '{"A":"1"}',
    headers: '{"X-Test":"ja"}',
    inventory_prompt: null,
    side_effect: 'read',
    enabled: 1,
  });
  try {
    const maskiert = listMcpServers(false).find((r) => r.id === row.id);
    assert.equal(maskiert?.auth_token, null);
    assert.equal(maskiert?.env, null);
    assert.equal(maskiert?.headers, null);
    const klar = listMcpServers(false, true).find((r) => r.id === row.id);
    assert.equal(klar?.auth_token, 'token-abc');
    assert.equal(klar?.env, '{"A":"1"}');
    assert.equal(klar?.headers, '{"X-Test":"ja"}');
    assert.equal(klar?.side_effect, 'read', 'side_effect wird uebernommen');
  } finally {
    deleteMcpServer(row.id);
  }
});

test('updateMcpServer: clearSecrets wischt nur die genannten Spalten', () => {
  const row = createMcpServer({
    name: 'coverage-clear',
    url: 'https://mcp.example.org/rpc4',
    auth_token: 'altes-token',
    transport: 'http',
    command: null,
    args: null,
    env: '{"A":"1"}',
    headers: '{"H":"1"}',
    inventory_prompt: null,
    enabled: 1,
  });
  try {
    const input = {
      name: 'coverage-clear',
      url: 'https://mcp.example.org/rpc4',
      auth_token: null,
      transport: 'http' as const,
      command: null,
      args: null,
      env: null,
      headers: null,
      inventory_prompt: null,
      enabled: 1,
    };
    // Unbekannte Spalte wird ignoriert, auth_token bleibt erhalten.
    updateMcpServer(row.id, input, ['unbekannt']);
    const unveraendert = getMcpServer(row.id);
    assert.equal(unveraendert?.auth_token, 'altes-token');
    // Explizites Loeschen.
    updateMcpServer(row.id, input, ['auth_token', 'env', 'headers']);
    const geleert = getMcpServer(row.id);
    assert.equal(geleert?.auth_token, null);
    assert.equal(geleert?.env, null);
    assert.equal(geleert?.headers, null);
  } finally {
    deleteMcpServer(row.id);
  }
});

test('isPrivateHost: ungueltiger Hostname ist nicht privat', () => {
  assert.equal(isPrivateHost('example.com'), false);
  assert.equal(isPrivateHost('nicht.ein.ip.'), false);
});
