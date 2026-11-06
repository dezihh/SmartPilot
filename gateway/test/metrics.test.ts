// Metrik-Registry: Zaehler/Gauges, Label-Format und Prometheus-Textausgabe.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { incCounter, setGauge, resetMetrics, renderMetrics } from '../src/core/metrics.js';

beforeEach(() => resetMetrics());

test('leere Registry liefert leeren Text', () => {
  assert.equal(renderMetrics(), '');
});

test('Zaehler summiert gleiche Labels und trennt verschiedene', () => {
  incCounter('smartpilot_test_total', { status: '200' }, 'Testzaehler');
  incCounter('smartpilot_test_total', { status: '200' }, 'Testzaehler');
  incCounter('smartpilot_test_total', { status: '500' }, 'Testzaehler');
  const out = renderMetrics();
  assert.match(out, /# HELP smartpilot_test_total Testzaehler/);
  assert.match(out, /# TYPE smartpilot_test_total counter/);
  assert.match(out, /smartpilot_test_total\{status="200"\} 2/);
  assert.match(out, /smartpilot_test_total\{status="500"\} 1/);
});

test('Zaehler addiert Werte, Gauge setzt sie', () => {
  incCounter('sum_total', {}, 'Summe', 1.5);
  incCounter('sum_total', {}, 'Summe', 2);
  setGauge('gauge_test', 10, {}, 'Gauge');
  setGauge('gauge_test', 4, {}, 'Gauge');
  const out = renderMetrics();
  assert.match(out, /sum_total 3.5/);
  assert.match(out, /^gauge_test 4$/m);
  assert.match(out, /# TYPE gauge_test gauge/);
});

test('Labelwerte werden escaped', () => {
  setGauge('escaped', 1, { route: 'a"b\\c' });
  assert.match(renderMetrics(), /escaped\{route="a\\"b\\\\c"\} 1/);
});

test('Metriken sind alphabetisch sortiert', () => {
  setGauge('zzz', 1);
  setGauge('aaa', 1);
  const names = renderMetrics()
    .split('\n')
    .filter((l) => l.startsWith('# HELP'))
    .map((l) => l.split(' ')[2]);
  assert.deepEqual(names, ['aaa', 'zzz']);
});

test('zu viele Label-Kombinationen laufen in ein Sammel-Label', () => {
  for (let i = 0; i < 250; i++) incCounter('cardinality_total', { route: `r${i}` });
  const out = renderMetrics();
  const samples = out.split('\n').filter((l) => l.startsWith('cardinality_total'));
  assert.ok(samples.length <= 201, `zu viele Samples: ${samples.length}`);
  assert.match(out, /cardinality_total\{other="true"\} \d+/);
});

test('resetMetrics leert die Registry', () => {
  incCounter('temp_total', {});
  resetMetrics();
  assert.equal(renderMetrics(), '');
});
