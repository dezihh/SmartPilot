// Tests fuer den DB-Pfad-Default (F-D6): ohne DB_PATH soll eine vorhandene
// Legacy-Datei weiterverwendet werden, damit ein Upgrade keine leere DB anlegt.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.ts verlangt Pflicht-Env beim Import -> vor dem dynamischen Import setzen.
process.env.ADMIN_TOKEN = 'test-secret';
process.env.API_TOKEN = 'test-query-secret';
process.env.LLM_BASE_URL = 'http://127.0.0.1:9/v1';
process.env.LLM_API_KEY = 'test-key';
process.env.LLM_MODEL = 'test-model';
// Ungueltige Zahlen duerfen nicht als NaN in die Laufzeit gelangen.
process.env.PORT = 'abc';
process.env.LLM_MAX_TOKENS = 'abc';
process.env.AGENT_CLARIFICATION_BUDGET = 'abc';
process.env.MAX_TOOL_ITERATIONS = 'abc';
process.env.LLM_TOOL_DEADLINE_MS = 'abc';

const { resolveDbPath, normalizeBasePath, envPositiveNumber, config, assertTokensDistinct } = await import('../src/config.js');

test('envPositiveNumber: ungueltig/0/negativ -> Default, gueltig -> Wert', () => {
  assert.equal(envPositiveNumber('5', 1), 5);
  assert.equal(envPositiveNumber('abc', 7), 7);
  assert.equal(envPositiveNumber('0', 7), 7);
  assert.equal(envPositiveNumber('-3', 7), 7);
  assert.equal(envPositiveNumber(undefined, 7), 7);
  assert.equal(envPositiveNumber('  ', 7), 7);
});

test('config: ungueltige Zahlen fallen auf Defaults (kein NaN)', () => {
  assert.equal(config.port, 3000);
  assert.equal(config.llm.maxTokens, 2000);
  assert.equal(config.agentClarificationBudget, 2);
  assert.equal(config.maxToolIterations, 6);
  assert.equal(config.toolDeadlineMs, 9000);
});

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

test('normalizeBasePath: nur Slashes und umgebende Leerzeichen', () => {
  assert.equal(normalizeBasePath('//'), '');
  assert.equal(normalizeBasePath('   '), '');
  assert.equal(normalizeBasePath('  /foo  '), '/foo');
  assert.equal(normalizeBasePath('foo/'), '/foo');
  assert.equal(normalizeBasePath('a/b'), '/a/b');
});

test('config: identische Tokens verhindern den Start', () => {
  assert.throws(() => assertTokensDistinct('gleich', 'gleich'), /muessen sich unterscheiden/);
  assert.doesNotThrow(() => assertTokensDistinct('a', 'b'));
});
