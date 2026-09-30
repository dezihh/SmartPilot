import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractLiterals } from '../src/core/extract.js';

test('index.find mit Literal-Args: Default-Key + usesIndex', () => {
  const x = extractLiterals("{{ index.find('schlafzimmer temperatur') }}");
  assert.equal(x.usesIndex, true);
  assert.deepEqual(x.indexKeys, ['']);
  assert.equal(x.indexAll, false);
});

test('index.state mit explizitem Index-Key', () => {
  const x = extractLiterals("{{ index.state('sensor.wohnzimmer_temperatur', 'ma') }}");
  assert.deepEqual(x.states, [{ id: 'sensor.wohnzimmer_temperatur', key: 'ma' }]);
  assert.deepEqual(x.indexKeys, ['ma']);
});

test('dynamische Args: fn-Template mit index.find(args.query)', () => {
  const x = extractLiterals("{{ index.find(args.query, args.index | default('')) }}");
  // Key-Regex greift hier nicht (2. Arg ist args, nicht Literal) - der Preheat
  // laeuft trotzdem, weil indexAll=true alle konfigurierten Keys vorwaermt.
  assert.equal(x.usesIndex, false);
  assert.equal(x.indexAll, true);
  assert.deepEqual(x.indexKeys, []);
});

test('mcp.call Literal-Args', () => {
  const x = extractLiterals("{%- set s = mcp.call('brave_web_search', {'query': 'x', 'count': 5}) -%}");
  assert.deepEqual(x.calls, [{ tool: 'brave_web_search', args: "{'query': 'x', 'count': 5}" }]);
  assert.deepEqual(x.mcpCallDyn, []);
});

test('mcp.call mit args ist dynamisch, nicht literal', () => {
  const x = extractLiterals("{{ mcp.call('web_url_read', {'url': args.url}) }}");
  // Nicht-literal (args) -> KEIN calls-Eintrag, nur dynamische Expression.
  assert.deepEqual(x.calls, []);
  assert.equal(x.mcpCallDyn.length, 1);
  assert.ok(x.mcpCallDyn[0]!.expr.includes('args.url'));
});

test('mcp.call mit Fallback (Literal-Args)', () => {
  const tpl = "{{ mcp.call('searxng_web_search', {'query': 'x'}, {fallback: 'brave_web_search'}) }}";
  const x = extractLiterals(tpl);
  assert.deepEqual(x.calls, [{ tool: 'searxng_web_search', args: "{'query': 'x'}", fallback: 'brave_web_search' }]);
  assert.deepEqual(x.mcpCallDyn, []);
});

test('mcp.call mit Fallback (dynamische Args)', () => {
  const tpl = "{{ mcp.call('searxng_web_search', {'query': args.q}, { fallback: 'brave_web_search' }) }}";
  const x = extractLiterals(tpl);
  assert.deepEqual(x.calls, []);
  assert.equal(x.mcpCallDyn.length, 1);
  assert.ok(x.mcpCallDyn[0]!.expr.includes('args.q'));
  assert.equal(x.mcpCallDyn[0]!.fallback, 'brave_web_search');
});

test('shell- und fn-Abrufe', () => {
  const x = extractLiterals("{{ shell('uptime') }} {{ fn('find_entities') }}");
  assert.deepEqual(x.shells, ['uptime']);
  assert.deepEqual(x.fns, ['find_entities']);
});

test('http mit Literal-URL und TTL', () => {
  const x = extractLiterals("{{ http('https://example.com/rss', 300000).items }}");
  assert.deepEqual(x.httpCalls, [{ url: 'https://example.com/rss', ttl: 300000 }]);
  assert.deepEqual(x.httpDyn, []);
});

test('http mit dynamischer Expression und TTL-Suffix', () => {
  const x = extractLiterals("{{ http('https://' ~ args.host ~ '/rss', 60000) }}");
  assert.deepEqual(x.httpCalls, []);
  assert.equal(x.httpDyn.length, 1);
  assert.ok(x.httpDyn[0]!.expr.includes("args.host"));
  assert.equal(x.httpDyn[0]!.ttl, 60000);
});

test('keine Abrufe: alles leer', () => {
  const x = extractLiterals('Nur statischer Text {{ 1 + 1 }}');
  assert.equal(x.usesIndex, false);
  assert.equal(x.calls.length, 0);
  assert.equal(x.httpCalls.length, 0);
  assert.equal(x.shells.length, 0);
});
