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
// Tool-Aufrufe duerfen laenger dauern als init/listTools; HTTP und stdio
// verwenden denselben Wert, damit sich ein Server je Transport gleich verhaelt.
export const MCP_CALL_TIMEOUT_MS = 60_000;

// Gemeinsame Auswertung einer tools/call-Antwort fuer HTTP- und stdio-Client.
// MCP-Fehler kommen oft als erfolgreiches Result mit isError=true (statt
// JSON-RPC-error). Beide Transporte muessen gleich reagieren.
export function unwrapToolResult(
  name: string,
  res: { error?: { message: string }; result?: unknown } | null | undefined
): unknown {
  if (res?.error) throw new Error(`MCP tools/call ${name}: ${res.error.message}`);
  const result = res?.result as { isError?: boolean; content?: unknown } | undefined;
  if (result?.isError) {
    const text = Array.isArray(result.content)
      ? (result.content as { text?: string }[]).map((c) => c?.text ?? '').join(' ').trim()
      : '';
    throw new Error(`MCP tools/call ${name}: ${text.slice(0, 200) || 'Tool meldet Fehler'}`);
  }
  return res?.result;
}

export class McpClient implements McpTransport {
  private nextId = 1;
  private sessionId: string | null = null;

  private readonly timeoutMs: number;
  private readonly extraHeaders: Record<string, string>;

  constructor(
    private url: string,
    private token: string | null,
    options: { timeoutMs?: number; headers?: Record<string, string> } = {}
  ) {
    this.timeoutMs = options.timeoutMs ?? MCP_TIMEOUT_MS;
    this.extraHeaders = options.headers ?? {};
  }

  private async rpc(
    method: string,
    params: unknown,
    notify = false,
    allowReinit = true,
    timeoutMs = this.timeoutMs
  ): Promise<{ result?: unknown; error?: { code: number; message: string } } | null> {
    const id = notify ? undefined : this.nextId++;
    const body: Record<string, unknown> = { jsonrpc: '2.0', method, params };
    if (id !== undefined) body.id = id;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...this.extraHeaders,
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const res = await fetch(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (notify) return null;
    if (!res.ok) {
      const text = await res.text();
      // Server-Neustart/Idle-Timeout: die alte MCP-Session ist ungueltig
      // (404 "Session not found"). Einmal neu initialisieren und wiederholen,
      // sonst bleiben alle Tools bis zum Cache-Refresh (~5 min) kaputt.
      if (
        allowReinit &&
        method !== 'initialize' &&
        res.status === 404 &&
        /session (not found|expired)|no valid session/i.test(text)
      ) {
        this.sessionId = null;
        await this.init();
        return this.rpc(method, params, notify, false);
      }
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
    const res = await this.rpc('tools/call', { name, arguments: args }, false, true, MCP_CALL_TIMEOUT_MS);
    return unwrapToolResult(name, res);
  }
}
