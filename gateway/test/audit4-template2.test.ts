// Template-Renderer, zweite Runde (Audit F-001): Fehlerpfade von mcp.call,
// index.state, dynamischem http() und unbekannten Funktionen.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb } from '../src/db/schema.js';
import { renderActionTemplate } from '../src/core/template.js';
import type { McpContext } from '../src/mcp/registry.js';
import type { TraceEvent } from '../src/types.js';
import { tmpDb } from './_tmpdb.js';

before(() => {
  closeDb();
  initDb(tmpDb('audit4-template2'));
});

function mcpCtx(call: (name: string, args: unknown) => Promise<unknown>): McpContext {
  return {
    servers: [
      {
        id: 1,
        name: 'srv',
        sideEffect: 'read',
        tools: [{ name: 't', inputSchema: { type: 'object' } }],
        client: { init: async () => {}, listTools: async () => [], callTool: call },
      },
    ],
  } as unknown as McpContext;
}

test('mcp.call: leere Tool-Antwort bleibt leer', async () => {
  const trace: TraceEvent[] = [];
  const out = await renderActionTemplate("{% set x = mcp.call('t') %}[{{ x }}]", mcpCtx(async () => undefined), trace, {});
  assert.equal(out.speech, '[]');
});

test('index.state: unbekannte Entity erzeugt einen Fehler-Trace', async () => {
  const trace: TraceEvent[] = [];
  const out = await renderActionTemplate(
    "{% set x = index.state('gibt.es.nicht') %}{{ x or 'leer' }}",
    mcpCtx(async () => ({})),
    trace,
    {},
  );
  assert.equal(out.speech, 'leer');
  assert.ok(trace.some((t) => t.step.startsWith('template.state') || t.step.startsWith('template.index')));
});

test('http: dynamische URL-Ausdruecke werden verarbeitet (leer bleibt leer)', async () => {
  const trace: TraceEvent[] = [];
  const out = await renderActionTemplate(
    "{% set x = http('{{ args.a.b }}') %}{{ x or 'leer' }}",
    mcpCtx(async () => ({})),
    trace,
    {},
  );
  assert.equal(out.speech, 'leer');
});

test('fn: unbekannte Funktion bleibt leer', async () => {
  const trace: TraceEvent[] = [];
  const out = await renderActionTemplate(
    "{% set x = fn('gibt_es_nicht') %}{{ x or 'leer' }}",
    mcpCtx(async () => ({})),
    trace,
    {},
  );
  assert.equal(out.speech, 'leer');
});
