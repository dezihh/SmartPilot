// Vertragstest: HTTP- und stdio-Client muessen auf dieselben Serverantworten
// gleich reagieren (isError, JSON-RPC-Fehler, Erfolg). Beide laufen gegen
// denselben Fake-Server, nur der Transport unterscheidet sich.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { McpClient, type McpTransport } from '../src/mcp/client.js';
import { McpStdioClient } from '../src/mcp/stdio.js';

interface Reply {
  result?: unknown;
  error?: { code: number; message: string };
}
type Server = (method: string) => Reply;

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function httpClient(server: Server): McpTransport {
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id?: number; method: string };
    const payload = { jsonrpc: '2.0', id: body.id, ...server(body.method) };
    return {
      ok: true,
      status: 200,
      headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) },
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as unknown as Response;
  }) as typeof fetch;
  return new McpClient('https://mcp.example.org/rpc', null);
}

class PipeStream extends EventEmitter {
  constructor(private readonly onLine?: (line: string) => void) {
    super();
  }
  write(line: string): boolean {
    this.onLine?.(line);
    return true;
  }
  setEncoding(): void {}
}

function stdioClient(server: Server): McpTransport {
  const stdout = new PipeStream();
  const stdin = new PipeStream((line) => {
    const msg = JSON.parse(line) as { id?: number; method: string };
    if (msg.id === undefined) return;
    const payload = { jsonrpc: '2.0', id: msg.id, ...server(msg.method) };
    // Antwort erst nach dem Registrieren des Pending-Requests zustellen.
    setImmediate(() => stdout.emit('data', `${JSON.stringify(payload)}\n`));
  });
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr: new PipeStream(),
    kill: () => true,
  });
  return new McpStdioClient({ command: 'x', args: [], env: {} }, () => child as unknown as ChildProcess);
}

const transports: [string, (s: Server) => McpTransport][] = [
  ['http', httpClient],
  ['stdio', stdioClient],
];

const scenarios: { name: string; server: Server; expected: RegExp }[] = [
  {
    name: 'isError=true mit Text wird als Fehler geworfen',
    server: () => ({ result: { isError: true, content: [{ type: 'text', text: 'schreibfehler' }] } }),
    expected: /schreibfehler/,
  },
  {
    name: 'isError=true ohne Text wird als Fehler geworfen',
    server: () => ({ result: { isError: true, content: [] } }),
    expected: /meldet Fehler/,
  },
  {
    name: 'JSON-RPC-Fehler wird als Fehler geworfen',
    server: () => ({ error: { code: -32000, message: 'boom' } }),
    expected: /boom/,
  },
];

for (const [transport, make] of transports) {
  for (const sc of scenarios) {
    test(`MCP-Paritaet (${transport}): ${sc.name}`, async () => {
      const client = make(sc.server);
      await assert.rejects(() => client.callTool('tool_x', {}), sc.expected);
    });
  }

  test(`MCP-Paritaet (${transport}): erfolgreiches Ergebnis bleibt unveraendert`, async () => {
    const client = make(() => ({ result: { content: [{ type: 'text', text: 'ok' }] } }));
    const res = (await client.callTool('tool_x', {})) as { content: { text: string }[] };
    assert.equal(res.content[0]?.text, 'ok');
  });
}
