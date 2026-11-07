// Letzte Coverage-Lücken (Audit F-001): Antwort-Parser-Randfälle und die
// Gefahrenklassifikation von Paket-Templates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAgentAnswer } from '../src/core/response.js';
import { manifestDangerous, validateManifest } from '../src/core/packages.js';
import type { TraceEvent } from '../src/types.js';

const BASE = { id: 'p', version: '1.0.0', name: 'P', summary: 'S', description: 'D' };

test('parseAgentAnswer: kaputtes JSON faellt auf Text zurueck und vermerkt es', () => {
  const trace: TraceEvent[] = [];
  const out = parseAgentAnswer('{kaputt', trace);
  assert.equal(out.speech, '{kaputt');
  assert.ok(trace.some((t) => t.step === 'agent.json_parse_error'));
});

test('parseAgentAnswer: leere Antwort und leeres speech werden vermerkt', () => {
  const trace: TraceEvent[] = [];
  const empty = parseAgentAnswer('   ', trace);
  assert.match(empty.speech, /nichts gefunden/);
  assert.ok(trace.some((t) => t.step === 'agent.empty_content'));

  const trace2: TraceEvent[] = [];
  const noSpeech = parseAgentAnswer('{"speech":"   "}', trace2);
  assert.match(noSpeech.speech, /nichts gefunden/);
  assert.ok(trace2.some((t) => t.step === 'agent.empty_speech'));
});

test('manifestDangerous: shell() im Funktions-Template ist gefaehrlich', () => {
  const danger = manifestDangerous({
    ...BASE,
    functions: [{ name: 'f', template: "{% set x = shell('ls') %}" }],
  } as never);
  assert.equal(danger.dangerous, true);
  assert.ok(danger.items.some((i) => i.includes('shell')));
});

test('manifestDangerous: Loopback-http() ist ack-pflichtig, LAN nur Hinweis', () => {
  const loopback = manifestDangerous({
    ...BASE,
    functions: [{ name: 'g', template: "{% set x = http('http://127.0.0.1/x') %}" }],
  } as never);
  assert.equal(loopback.dangerous, true);
  assert.ok(loopback.items.some((i) => i.includes('127.0.0.1')));

  const lan = manifestDangerous({
    ...BASE,
    functions: [{ name: 'h', template: "{% set x = http('http://192.168.1.5/x') %}" }],
  } as never);
  assert.equal(lan.dangerous, false);
  assert.ok(lan.info.some((i) => i.includes('192.168.1.5')));
});

test('validateManifest: Index- und Parameter-Randfaelle', () => {
  assert.equal(validateManifest({ ...BASE, params: [{ key: 'ok', label: 'L' }, { key: 'BAD KEY', label: 'L' }] }).ok, false);
  assert.equal(validateManifest({ ...BASE, indexes: [{ key: 'BAD!', config: {} }] }).ok, false);
});
