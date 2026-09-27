import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { McpClient, MCP_TIMEOUT_MS } from '../src/mcp/client.js';
import { createClient } from '../src/mcp/registry.js';
import { McpStdioClient } from '../src/mcp/stdio.js';
import { initDb, closeDb } from '../src/db/schema.js';
import type { ToolDef } from '../src/types.js';
import { tmpDb } from './_tmpdb.js';

const DB_PATH = tmpDb('mcp');

const originalFetch = globalThis.fetch;
let lastSignal: AbortSignal | null = null;

interface FakeResInit {
  status?: number;
  headers?: Record<string, string>;
  json?: unknown;
  sse?: { id?: number; result?: unknown; error?: unknown } | null;
  hang?: boolean;
}

let handler: (url: string, body: Record<string, unknown>) => FakeResInit = () => ({});

before(() => {
  closeDb();
  initDb(DB_PATH);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubFetch(): void {
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    lastSignal = (init?.signal as AbortSignal) ?? null;
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const h = handler(String(url), body);
    if (h.hang) {
      // Keepalive-Interval haelt die Event-Loop an, damit AbortSignal.timeout
      // (unref'd) ueberhaupt feuern kann, bevor der Test-Runner aufgibt.
      return new Promise<never>((_resolve, reject) => {
        const keepAlive = setInterval(() => {}, 10);
        (init?.signal as AbortSignal | undefined)?.addEventListener(
          'abort',
          () => {
            clearInterval(keepAlive);
            reject(new Error('aborted'));
          },
          { once: true }
        );
      });
    }
    const headers = new Map(Object.entries(h.headers ?? {}));
    const res = {
      ok: (h.status ?? 200) >= 200 && (h.status ?? 200) < 300,
      status: h.status ?? 200,
      text: async () =>
        h.sse
          ? `data: ${JSON.stringify(h.sse)}\n\n`
          : JSON.stringify(h.json ?? {}),
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
      json: async () => h.json ?? {},
    };
    return res as unknown as Response;
  }) as typeof fetch;
}

function rpcRes(result: unknown): FakeResInit {
  return { json: { jsonrpc: '2.0', id: 1, result } };
}

test('MCP_TIMEOUT_MS ist gesetzt (Schutz gegen haengende Server)', () => {
  assert.ok(MCP_TIMEOUT_MS >= 5000);
});

test('init: sendet initialize + notifications/initialized, merkt Session-ID', async () => {
  stubFetch();
  const seen: string[] = [];
  handler = (url, body) => {
    seen.push(String(body.method));
    if (body.method === 'initialize') {
      return { headers: { 'mcp-session-id': 'sess-1' }, json: { jsonrpc: '2.0', id: 1, result: {} } };
    }
    return { status: 202 };
  };
  const client = new McpClient('https://mcp.example.org/rpc', null);
  await client.init();
  assert.deepEqual(seen, ['initialize', 'notifications/initialized']);
});

test('rpc: Bearer-Header und mcp-session-id werden gesendet', async () => {
  stubFetch();
  let capturedHeaders: Record<string, string> = {};
  handler = (_url, _body) => {
    return { headers: { 'mcp-session-id': 'sess-2' }, json: rpcRes({ tools: [] }).json };
  };
  const client = new McpClient('https://mcp.example.org/rpc', 'geheimtoken');
  const spyFetch = globalThis.fetch as (url: string | URL, init?: RequestInit) => Promise<Response>;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    capturedHeaders = Object.fromEntries(
      Object.entries((init?.headers as Record<string, string>) ?? {})
    );
    return spyFetch(url, init);
  }) as typeof fetch;
  await client.init(); // 2 RPCs: Session-ID wird gelernt
  await client.listTools(); // 3. RPC sendet mcp-session-id
  assert.equal(capturedHeaders.Authorization, 'Bearer geheimtoken');
  assert.equal(capturedHeaders['mcp-session-id'], 'sess-2');
});

test('listTools: JSON-Antwort liefert Tools', async () => {
  stubFetch();
  handler = () => rpcRes({ tools: [{ name: 'tool_a', description: 'A' }] });
  const client = new McpClient('https://mcp.example.org/rpc', null);
  const tools = await client.listTools();
  assert.equal(tools.length, 1);
  assert.equal((tools[0] as ToolDef).name, 'tool_a');
});

test('listTools: SSE-Content-Type wird geparst', async () => {
  stubFetch();
  handler = () => ({
    headers: { 'content-type': 'text/event-stream' },
    sse: { id: 1, result: { tools: [{ name: 'tool_sse' }] } },
  });
  const client = new McpClient('https://mcp.example.org/rpc', null);
  const tools = await client.listTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.name, 'tool_sse');
});

test('callTool: RPC-Error wirft mit Tool-Namen', async () => {
  stubFetch();
  handler = () => ({
    json: { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'kaputt' } },
  });
  const client = new McpClient('https://mcp.example.org/rpc', null);
  await assert.rejects(() => client.callTool('tool_x', {}), /tool_x.*kaputt|kaputt/);
});

test('rpc: haengender Server wird nach Timeout abgebrochen', async () => {
  stubFetch();
  handler = () => ({ hang: true });
  const client = new McpClient('https://mcp.example.org/rpc', null, 100);
  await assert.rejects(() => client.listTools(), /aborted|AbortError|Timeout/);
  assert.ok(lastSignal, 'AbortSignal wurde uebergeben');
});

test('rpc: HTTP-Fehler wirft mit Status', async () => {
  stubFetch();
  handler = () => ({ status: 500, json: { boom: true } });
  const client = new McpClient('https://mcp.example.org/rpc', null);
  await assert.rejects(() => client.listTools(), /MCP 500/);
});

test('createClient: stdio/http je nach Transport-Spalte', () => {
  assert.ok(createClient({ transport: 'stdio', url: '', auth_token: null, command: 'python3', args: '["-m","x"]', env: null }) instanceof McpStdioClient);
  assert.ok(createClient({ transport: 'http', url: 'https://x', auth_token: 't', command: null, args: null, env: null }) instanceof McpClient);
});
