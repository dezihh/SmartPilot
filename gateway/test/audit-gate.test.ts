// Unit-Tests fuer das Audit-Gate: High/Critical blockieren, Ausnahmen nur mit
// Begruendung, Doku-Verweis, Trigger und Ablaufdatum. Abgelaufene und verwaiste
// Eintraege muessen das Gate rot machen, sonst verrottet die Allowlist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAudit, type AuditException } from '../src/core/auditGate.js';

const TODAY = '2026-11-06';

function via(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 1243079,
    name: 'undici',
    title: 'Denial of Service',
    url: 'https://github.com/advisories/GHSA-4qv8-2p9j-2685',
    severity: 'moderate',
    ...extra,
  };
}

function report(severity: string, entries: unknown[] = [via()]): unknown {
  return { vulnerabilities: { undici: { name: 'undici', severity, via: entries } } };
}

function exception(extra: Partial<AuditException> = {}): AuditException {
  return {
    id: 'GHSA-4QV8-2P9J-2685',
    package: 'undici',
    reason: 'Alte Hardware spricht nur TLS 1.0, Fix bricht die Anbindung',
    doc: 'doc/DEPENDENCIES.md',
    trigger: 'Hardware-Abloesung oder Upstream-Fix',
    expires: '2027-06-30',
    ...extra,
  };
}

test('leerer Bericht ist frei', () => {
  const r = evaluateAudit({ vulnerabilities: {} }, [], TODAY);
  assert.equal(r.invalidReport, null);
  assert.deepEqual(r.blocking, []);
  assert.deepEqual(r.errors, []);
});

test('High ohne Allowlist blockiert', () => {
  const r = evaluateAudit(report('high'), [], TODAY);
  assert.equal(r.blocking.length, 1);
  assert.equal(r.blocking[0]?.package, 'undici');
});

test('Critical blockiert ebenfalls', () => {
  const r = evaluateAudit(report('critical'), [], TODAY);
  assert.equal(r.blocking.length, 1);
});

test('moderate und low werden nicht bewertet', () => {
  for (const severity of ['moderate', 'low', 'info']) {
    const r = evaluateAudit(report(severity), [], TODAY);
    assert.deepEqual(r.blocking, [], severity);
    assert.deepEqual(r.errors, [], severity);
  }
});

test('GHSA-Id wird aus der Advisory-URL gezogen', () => {
  const r = evaluateAudit(report('high'), [], TODAY);
  assert.equal(r.blocking[0]?.id, 'GHSA-4QV8-2P9J-2685');
  assert.equal(r.blocking[0]?.url, 'https://github.com/advisories/GHSA-4qv8-2p9j-2685');
});

test('ohne URL dient die numerische Advisory-Id als Kennung', () => {
  const r = evaluateAudit(report('high', [via({ url: '', source: 999 })]), [], TODAY);
  assert.equal(r.blocking[0]?.id, '999');
});

test('transitive Kette ohne Advisory-Objekt nutzt den Abhaengigkeitsnamen', () => {
  const r = evaluateAudit(report('high', ['node-fetch']), [], TODAY);
  assert.equal(r.blocking[0]?.id, 'node-fetch');
  assert.match(r.blocking[0]?.title ?? '', /node-fetch/);
});

test('mehrere Advisories desselben Pakets werden einzeln gefuehrt', () => {
  const r = evaluateAudit(
    report('high', [via(), via({ url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc' })]),
    [],
    TODAY,
  );
  assert.equal(r.blocking.length, 2);
});

test('passende Ausnahme macht den Befund akzeptiert', () => {
  const r = evaluateAudit(report('high'), [exception()], TODAY);
  assert.deepEqual(r.blocking, []);
  assert.equal(r.accepted.length, 1);
  assert.equal(r.accepted[0]?.exception.id, 'GHSA-4QV8-2P9J-2685');
  assert.deepEqual(r.errors, []);
});

test('Ausnahme gilt am Ablauftag noch', () => {
  const r = evaluateAudit(report('high'), [exception({ expires: TODAY })], TODAY);
  assert.deepEqual(r.blocking, []);
  assert.deepEqual(r.errors, []);
});

test('abgelaufene Ausnahme blockiert und meldet den Grund', () => {
  const r = evaluateAudit(report('high'), [exception({ expires: '2026-11-05' })], TODAY);
  assert.equal(r.blocking.length, 1);
  assert.match(r.errors.join(' '), /abgelaufen/);
});

test('verwaiste Ausnahme ist ein Fehler', () => {
  const r = evaluateAudit(report('high'), [exception({ id: 'GHSA-zzzz-zzzz-zzzz' })], TODAY);
  assert.equal(r.blocking.length, 1);
  assert.match(r.errors.join(' '), /verwaist/);
});

test('Ausnahme fuer ein anderes Paket greift nicht', () => {
  const r = evaluateAudit(report('high'), [exception({ package: 'express' })], TODAY);
  assert.equal(r.blocking.length, 1);
});

test('unvollstaendige Ausnahme wird abgelehnt', () => {
  const r = evaluateAudit(report('high'), [{ id: 'GHSA-4QV8-2P9J-2685' }], TODAY);
  assert.match(r.errors.join(' '), /Feld "package" fehlt/);
  assert.equal(r.blocking.length, 1);
});

test('zu kurze Begruendung wird abgelehnt', () => {
  const r = evaluateAudit(report('high'), [exception({ reason: 'zu alt' })], TODAY);
  assert.match(r.errors.join(' '), /Begruendung zu kurz/);
});

test('ungueltiges Ablaufdatum wird abgelehnt', () => {
  const r = evaluateAudit(report('high'), [exception({ expires: '2027-13-99' })], TODAY);
  assert.match(r.errors.join(' '), /JJJJ-MM-TT/);
});

test('doppelter Eintrag wird gemeldet', () => {
  const r = evaluateAudit(report('high'), [exception(), exception()], TODAY);
  assert.match(r.errors.join(' '), /doppelter Eintrag/);
});

test('Allowlist ohne Array ist ein Fehler und blockiert', () => {
  const r = evaluateAudit(report('high'), { undici: true }, TODAY);
  assert.equal(r.blocking.length, 1);
  assert.match(r.errors.join(' '), /kein Array/);
});

test('nicht lesbarer Bericht wird als solcher gemeldet', () => {
  const r = evaluateAudit({}, [], TODAY);
  assert.notEqual(r.invalidReport, null);
  const r2 = evaluateAudit(null, [], TODAY);
  assert.notEqual(r2.invalidReport, null);
});

test('Paket ohne via-Eintrag blockiert trotzdem', () => {
  const r = evaluateAudit({ vulnerabilities: { undici: { severity: 'high' } } }, [], TODAY);
  assert.equal(r.blocking.length, 1);
  assert.equal(r.blocking[0]?.id, 'undici');
});
