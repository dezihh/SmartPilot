// Tests fuer die Diff-Coverage: nur geaenderte Produktivzeilen zaehlen,
// kritische Pfade brauchen 100 %, nicht instrumentierte Zeilen fallen nicht
// ins Gewicht.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeDiffCoverage,
  isCriticalFile,
  normalizeSourcePath,
  parseLcov,
  parseUnifiedDiff,
  type LineRange,
} from '../src/core/diffCoverage.js';

test('normalizeSourcePath schneidet alles vor src/ ab', () => {
  assert.equal(normalizeSourcePath('b/gateway/src/app.ts'), 'src/app.ts');
  assert.equal(normalizeSourcePath('src/core/session.ts'), 'src/core/session.ts');
  assert.equal(normalizeSourcePath('README.md'), null);
});

test('parseUnifiedDiff sammelt hinzugefuegte Zeilen je Datei', () => {
  const diff = [
    'diff --git a/gateway/src/app.ts b/gateway/src/app.ts',
    '--- a/gateway/src/app.ts',
    '+++ b/gateway/src/app.ts',
    '@@ -1,0 +2,3 @@',
    '@@ -10 +13,2 @@',
    '+++ b/gateway/src/new.ts',
    '@@ -0,0 +1,2 @@',
  ].join('\n');

  const files = parseUnifiedDiff(diff);
  assert.deepEqual(files.get('src/app.ts'), [
    [2, 4],
    [13, 14],
  ]);
  assert.deepEqual(files.get('src/new.ts'), [[1, 2]]);
});

test('parseUnifiedDiff ignoriert geloeschte und fremde Dateien', () => {
  const diff = [
    '--- a/src/gone.ts',
    '+++ /dev/null',
    '@@ -1,3 +0,0 @@',
    '+++ b/README.md',
    '@@ -1 +1 @@',
  ].join('\n');

  assert.equal(parseUnifiedDiff(diff).size, 0);
});

test('parseLcov liest Zeilentreffer und trennt Dateien', () => {
  const lcov = [
    'SF:src/a.ts',
    'DA:1,3',
    'DA:2,0',
    'end_of_record',
    'SF:src/b.ts',
    'DA:5,1',
    'end_of_record',
  ].join('\n');

  const coverage = parseLcov(lcov);
  assert.equal(coverage.get('src/a.ts')?.get(1), 3);
  assert.equal(coverage.get('src/a.ts')?.get(2), 0);
  assert.equal(coverage.get('src/b.ts')?.get(5), 1);
});

test('Diff-Coverage erreicht die Schwelle genau', () => {
  const files = new Map<string, LineRange[]>([['src/app.ts', [[1, 10]]]]);
  const hits = new Map([1, 2, 3, 4, 5, 6, 7, 8, 9].map((line) => [line, 1]));
  hits.set(10, 0);
  const result = computeDiffCoverage(files, new Map([['src/app.ts', hits]]));

  assert.equal(result.total, 10);
  assert.equal(result.covered, 9);
  assert.equal(result.ok, true);
});

test('Diff-Coverage meldet zu wenig Abdeckung', () => {
  const files = new Map<string, LineRange[]>([['src/app.ts', [[1, 10]]]]);
  const hits = new Map([1, 2, 3, 4, 5, 6, 7, 8].map((line) => [line, 1]));
  hits.set(9, 0);
  hits.set(10, 0);
  const result = computeDiffCoverage(files, new Map([['src/app.ts', hits]]));

  assert.equal(result.ok, false);
  assert.deepEqual(result.failures, ['src/app.ts']);
});

test('kritischer Pfad verlangt 100 Prozent', () => {
  const files = new Map<string, LineRange[]>([
    ['src/auth.ts', [[1, 4]]],
    ['src/app.ts', [[1, 10]]],
  ]);
  const coverage = new Map([
    ['src/auth.ts', new Map([
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 0],
    ])],
    ['src/app.ts', new Map([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((line) => [line, 1]))],
  ]);
  const result = computeDiffCoverage(files, coverage);

  assert.equal(result.ok, false);
  assert.deepEqual(result.failures, ['src/auth.ts']);
  assert.equal(result.files.find((file) => file.file === 'src/auth.ts')?.required, 100);
});

test('Datei ohne LCOV-Eintrag gilt als ungetestet', () => {
  const files = new Map<string, LineRange[]>([['src/new.ts', [[1, 3]]]]);
  const result = computeDiffCoverage(files, new Map());

  assert.equal(result.total, 3);
  assert.equal(result.covered, 0);
  assert.equal(result.ok, false);
});

test('nicht instrumentierte Zeilen zaehlen nicht mit', () => {
  const files = new Map<string, LineRange[]>([['src/app.ts', [[10, 12]]]]);
  const coverage = new Map([
    ['src/app.ts', new Map([
      [10, 1],
      [11, 1],
    ])],
  ]);
  const result = computeDiffCoverage(files, coverage);

  assert.equal(result.total, 2);
  assert.equal(result.covered, 2);
});

test('leerer Diff ist gruen', () => {
  const result = computeDiffCoverage(new Map(), new Map());

  assert.equal(result.total, 0);
  assert.equal(result.pct, 100);
  assert.equal(result.ok, true);
  assert.deepEqual(result.files, []);
});

test('isCriticalFile erkennt Standardpfade', () => {
  assert.equal(isCriticalFile('src/auth.ts'), true);
  assert.equal(isCriticalFile('src/db/migrations.ts'), true);
  assert.equal(isCriticalFile('src/routes/helpers.ts'), false);
});
