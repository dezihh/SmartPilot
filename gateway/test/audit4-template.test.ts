// Template-Renderer (Audit F-001): mcp.call-Pfade ohne echten MCP-Server.
// Deckt Tool-Lookup, Args-Parsing (Jinja-Anführungszeichen), Ergebnis-
// Extraktion und die Fallback-Kaskade ab.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderActionTemplate } from '../src/core/template.js';
import type { McpContext } from '../src/mcp/registry.js';
import type { TraceEvent } from '../src/types.js';

function mcpCtx(
  toolNames: string[],
  call: (name: string, args: unknown) => Promise<unknown>,
): McpContext {
  return {
    servers: [
      {
        id: 1,
        name: 'srv',
        sideEffect: 'read',
        tools: toolNames.map((name) => ({ name, inputSchema: { type: 'object' } })),
        client: {
          init: async () => {},
          listTools: async () => [],
          callTool: call,
        },
      },
    ],
  } as unknown as McpContext;
}

test('mcp.call: unbekanntes Tool erzeugt Fehler-Trace und leeres Ergebnis', async () => {
  const trace: TraceEvent[] = [];
  const out = await renderActionTemplate("{% set x = mcp.call('fehlt') %}{{ x or 'leer' }}", mcpCtx([], async () => ({})), trace, {});
  assert.equal(out.speech, 'leer');
  assert.ok(trace.some((t) => t.step === 'template.mcp.error'));
});

test('mcp.call: Literal-Args mit einfachen Anfuehrungszeichen werden toleriert', async () => {
  const trace: TraceEvent[] = [];
  const mcp = mcpCtx(['t'], async () => ({ content: [{ type: 'text', text: 'OK' }] }));
  const out = await renderActionTemplate("{% set x = mcp.call('t', {'a': 1}) %}{{ x }}", mcp, trace, {});
  assert.equal(out.speech, 'OK');
});

test('mcp.call: primitive Tool-Antwort wird als Text verwendet', async () => {
  const trace: TraceEvent[] = [];
  const mcp = mcpCtx(['t'], async () => 'PRIMITIV');
  const out = await renderActionTemplate("{% set x = mcp.call('t') %}{{ x }}", mcp, trace, {});
  assert.equal(out.speech, 'PRIMITIV');
});

test('mcp.call: Fallback greift, wenn das Primaer-Tool leer bleibt', async () => {
  const trace: TraceEvent[] = [];
  const mcp = mcpCtx(['leer', 'fb'], async (name) => ({
    content: [{ type: 'text', text: name === 'fb' ? 'FALLBACK' : '' }],
  }));
  const out = await renderActionTemplate(
    "{% set x = mcp.call('leer', {}, { fallback: 'fb' }) %}{{ x }}",
    mcp,
    trace,
    {},
  );
  assert.equal(out.speech, 'FALLBACK');
});
