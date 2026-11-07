#!/usr/bin/env node
// Audit-Gate: prueft die Produktionsabhaengigkeiten auf bekannte Advisories.
//
// High/Critical blockieren. Eine Ausnahme ist nur zulaessig, wenn sie in
// audit-allowlist.json mit Begruendung, Doku-Verweis, Trigger und Ablaufdatum
// steht; der Doku-Verweis muss existieren. Veraltete oder verwaiste Eintraege
// lassen das Gate rot werden - so verrottet keine Ausnahme.
//
// Exit-Codes: 0 = frei, 1 = Befund, 2 = nicht bewertbar (GRAU).
//
// Nutzung:
//   npm run audit:gate
//   npm run audit:gate -- --input /tmp/audit.json --today 2026-11-06
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateAudit } from '../src/core/auditGate.ts';

const GATEWAY_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_DIR = dirname(GATEWAY_DIR);

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const today = arg('today', new Date().toISOString().slice(0, 10));
const allowlistPath = resolve(arg('allowlist', join(GATEWAY_DIR, 'audit-allowlist.json')));
const inputPath = arg('input', '');

function fail(message) {
  console.error(`Audit-Gate: ${message}`);
  process.exit(2);
}

const AUDIT_TIMEOUT_MS = 120_000;

function runNpmAudit() {
  const res = spawnSync('npm', ['audit', '--omit=dev', '--json'], {
    cwd: GATEWAY_DIR,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    // Ein haengendes npm (Netz, Registry) darf den CI-Job nicht blockieren;
    // Timeout endet als "nicht bewertbar" (Exit 2, GRAU) - nie als gruen (F-016).
    timeout: AUDIT_TIMEOUT_MS,
  });
  if (res.error) {
    const timedOut = res.error.code === 'ETIMEDOUT';
    fail(timedOut
      ? `npm audit nach ${AUDIT_TIMEOUT_MS} ms abgebrochen`
      : `npm audit nicht ausfuehrbar (${res.error.message})`);
  }
  const raw = res.stdout ?? '';
  if (raw.trim() === '') fail('npm audit lieferte keine Ausgabe');
  return raw;
}

let reportRaw;
if (inputPath) {
  if (!existsSync(inputPath)) fail(`Eingabedatei ${inputPath} fehlt`);
  reportRaw = readFileSync(inputPath, 'utf8');
} else {
  reportRaw = runNpmAudit();
}

let report;
try {
  report = JSON.parse(reportRaw);
} catch {
  fail('Audit-Bericht ist kein JSON');
}

let allowlist = [];
if (existsSync(allowlistPath)) {
  try {
    allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8'));
  } catch {
    fail(`Allowlist ${allowlistPath} ist kein JSON`);
  }
} else {
  console.error(`Audit-Gate: keine Allowlist unter ${allowlistPath} - es gilt keine Ausnahme`);
}

const result = evaluateAudit(report, allowlist, today);
const errors = [...result.errors];

// Ein Doku-Verweis, den es nicht gibt, ist keine Dokumentation.
if (Array.isArray(allowlist)) {
  for (const entry of allowlist) {
    if (typeof entry?.doc !== 'string' || entry.doc.trim() === '') continue;
    if (!existsSync(resolve(REPO_DIR, entry.doc))) {
      errors.push(`Ausnahme ${entry.id} (${entry.package}): Doku ${entry.doc} existiert nicht`);
    }
  }
}

if (result.invalidReport !== null) fail(result.invalidReport);

console.log('Audit-Gate (Produktionsabhaengigkeiten)');
if (result.blocking.length === 0) {
  console.log('  offen:      keine High-/Critical-Advisory');
} else {
  console.log('  offen:');
  for (const a of result.blocking) {
    console.log(`    ${a.severity.toUpperCase().padEnd(8)} ${a.package}  ${a.id}  ${a.title}`);
    if (a.url) console.log(`             ${a.url}`);
  }
}
if (result.accepted.length > 0) {
  console.log('  akzeptiert:');
  for (const { advisory, exception } of result.accepted) {
    console.log(`    ${advisory.package}  ${advisory.id}  bis ${exception.expires}  (${exception.doc})`);
    console.log(`             Trigger: ${exception.trigger}`);
  }
}
for (const e of errors) console.error(`  Fehler:     ${e}`);

const red = result.blocking.length > 0 || errors.length > 0;
console.log(
  `Ergebnis: ${red ? 'ROT' : 'GRUEN'} ` +
    `(${result.blocking.length} offen, ${result.accepted.length} akzeptiert, ${errors.length} Fehler)`,
);
process.exit(red ? 1 : 0);
