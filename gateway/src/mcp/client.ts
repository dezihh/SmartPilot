import type { ToolDef } from '../types.js';

export interface McpTransport {
  init(): Promise<void>;
  listTools(): Promise<ToolDef[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  stop?(): void;
}

// Ein haengender MCP-Server darf Template-Preheat/Render nicht unendlich
// blockieren (deterministic-Pfad hat keine eigene Gesamt-Deadline).
export const MCP_TIMEOUT_MS = 30_000;

export class McpClient implements McpTransport {
  private nextId = 1;
  private sessionId: string | null = null;

  constructor(
    private url: string,
    private token: string | null,
    private timeoutMs: number = MCP_TIMEOUT_MS
  ) {}

  private async rpc(
    method: string,
    params: unknown,
    notify = false
  ): Promise<{ result?: unknown; error?: { code: number; message: string } } | null> {
    const id = notify ? undefined : this.nextId++;
    const body: Record<string, unknown> = { jsonrpc: '2.0', method, params };
    if (id !== undefined) body.id = id;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const res = await fetch(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (notify) return null;
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`MCP ${res.status}: ${text.slice(0, 200)}`);
    }
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) {
      const text = await res.text();
      let parsed: { result?: unknown; error?: { code: number; message: string } } | null = null;
      for (const line of text.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try {
          const msg = JSON.parse(line.slice(5).trim()) as {
            id?: number;
            result?: unknown;
            error?: { code: number; message: string };
          };
          if (msg.id === id) parsed = msg;
        } catch {
          continue;
        }
      }
      if (!parsed) throw new Error(`MCP: keine Antwort für ID ${id}`);
      return parsed;
    }
    return (await res.json()) as { result?: unknown; error?: { code: number; message: string } };
  }

  async init(): Promise<void> {
    await this.rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'smartpilot', version: '0.1.0' },
    });
    await this.rpc('notifications/initialized', {}, true);
  }

  async listTools(): Promise<ToolDef[]> {
    const res = await this.rpc('tools/list', {});
    if (res?.error) throw new Error(`MCP tools/list: ${res.error.message}`);
    const result = res?.result as { tools?: ToolDef[] } | undefined;
    return result?.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const res = await this.rpc('tools/call', { name, arguments: args });
    if (res?.error) throw new Error(`MCP tools/call ${name}: ${res.error.message}`);
    // MCP-Fehler kommen oft als erfolgreiches Result mit isError=true (statt
    // JSON-RPC-error). In den Fehlerpfad/Trace ueberfuehren.
    const result = res?.result as { isError?: boolean; content?: unknown } | undefined;
    if (result?.isError) {
      const text = Array.isArray(result.content)
        ? (result.content as { text?: string }[]).map((c) => c?.text ?? '').join(' ').trim()
        : '';
      throw new Error(`MCP tools/call ${name}: ${text.slice(0, 200) || 'Tool meldet Fehler'}`);
    }
    return res?.result;
  }
}
