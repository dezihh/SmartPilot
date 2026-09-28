// Tests fuer den DB-Pfad-Default (F-D6): ohne DB_PATH soll eine vorhandene
// Legacy-Datei weiterverwendet werden, damit ein Upgrade keine leere DB anlegt.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.ts verlangt Pflicht-Env beim Import -> vor dem dynamischen Import setzen.
process.env.AUTH_TOKEN = 'test-secret';
process.env.LLM_BASE_URL = 'http://127.0.0.1:9/v1';
process.env.LLM_API_KEY = 'test-key';
process.env.LLM_MODEL = 'test-model';

const { resolveDbPath, normalizeBasePath } = await import('../src/config.js');

test('resolveDbPath: explizites DB_PATH hat Vorrang', () => {
  assert.equal(resolveDbPath('/x/custom.db', () => true), '/x/custom.db');
});

test('resolveDbPath: vorhandene Legacy-Datei wird ohne DB_PATH weiterverwendet (F-D6)', () => {
  const onlyLegacy = (p: string) => p.endsWith('meinhelfer.db');
  assert.equal(resolveDbPath(undefined, onlyLegacy), './data/meinhelfer.db');
});

test('resolveDbPath: sonst smartpilot.db (Default, auch wenn Datei existiert)', () => {
  assert.equal(resolveDbPath(undefined, () => false), './data/smartpilot.db');
  assert.equal(resolveDbPath(undefined, () => true), './data/smartpilot.db');
});

test('normalizeBasePath: Wurzel und Trailing-Slash normalisieren', () => {
  assert.equal(normalizeBasePath(undefined), '');
  assert.equal(normalizeBasePath(''), '');
  assert.equal(normalizeBasePath('/'), '');
  assert.equal(normalizeBasePath('///'), '');
  assert.equal(normalizeBasePath('smartpilot'), '/smartpilot');
  assert.equal(normalizeBasePath('/smartpilot/'), '/smartpilot');
  assert.equal(normalizeBasePath('/a/b//'), '/a/b');
});
