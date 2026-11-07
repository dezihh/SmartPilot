#!/usr/bin/env node
// Diff-Coverage: prueft nur die in einem Diff geaenderten Produktivzeilen.
//
// Die globale Quote ist eine Regressionsbremse, kein Testziel (NFR 6).
// Kritische Pfade muessen vollstaendig abgedeckt sein.
//
// Eingabe: Unified Diff auf stdin (oder --diff <datei>) und ein LCOV-Bericht
// (--lcov, Standard coverage/lcov.info). Der Diff wird bewusst auf dem Host
// erzeugt, weil im Runtime-/Dev-Container kein git installiert ist.
//
// Nutzung (Host-Workspace):
//   git diff -U0 "$(git merge-base origin/main HEAD)" -- gateway/src \
//     | docker exec -i smartpilot-gateway-gateway-1 npm run coverage:diff
//
// Exit-Codes: 0 = Schwelle erreicht, 1 = Befund, 2 = nicht bewertbar.
import { existsSync, readFileSync } from 'node:fs';
import {
  DEFAULT_CRITICAL,
  computeDiffCoverage,
  parseLcov,
  parseUnifiedDiff,
} from '../src/core/diffCoverage.ts';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    console.error(`Fehlender Wert fuer --${name}`);
    process.exit(2);
  }
  return value;
}

const lcovPath = arg('lcov', 'coverage/lcov.info');
const diffPath = arg('diff', null);
const threshold = Number(arg('threshold', '90'));
const critical = arg('critical', '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);

if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
  console.error('--threshold muss zwischen 0 und 100 liegen.');
  process.exit(2);
}
if (!existsSync(lcovPath)) {
  console.error(`LCOV-Bericht fehlt: ${lcovPath}\nErst erzeugen: npm run coverage:lcov`);
  process.exit(2);
}

const diff = diffPath ? readFileSync(diffPath, 'utf8') : readFileSync(0, 'utf8');
const changed = parseUnifiedDiff(diff);
const coverage = parseLcov(readFileSync(lcovPath, 'utf8'));
const result = computeDiffCoverage(changed, coverage, {
  threshold,
  critical: critical.length > 0 ? critical : DEFAULT_CRITICAL,
});

console.log('Diff-Coverage (nur geaenderte Produktivzeilen)');
if (result.files.length === 0) {
  console.log('  keine geaenderten src/-Zeilen');
}
for (const file of result.files) {
  const marker = file.ok ? 'ok  ' : 'FAIL';
  const scope = file.required === 100 ? ' kritisch' : '';
  console.log(
    `  ${marker} ${file.file.padEnd(32)} ${String(file.covered).padStart(4)}/${String(
      file.total,
    ).padEnd(4)} ${file.pct.toFixed(1).padStart(5)} %  (Schwelle ${file.required} %)${scope}`,
  );
}
console.log(
  `  Gesamt ${result.covered}/${result.total} = ${result.pct.toFixed(1)} % ` +
    `(Schwelle ${result.threshold} %)`,
);

if (!result.ok) {
  console.error(`Diff-Coverage verfehlt: ${result.failures.join(', ') || 'Gesamtquote'}`);
  process.exit(1);
}
