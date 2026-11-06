import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { listMcpServers } from '../db.js';
import { config } from '../config.js';
import { parseHeaders } from '../core/normalize.js';
import type { McpServerRow, SideEffect, ToolDef } from '../types.js';
import { McpClient, type McpTransport } from './client.js';
import { McpStdioClient } from './stdio.js';

// stdio-Command aufloesen: Ein relativer `node_modules/.bin/<bin>` zeigt im
// Betrieb auf das Image-/Dev-Volume; fehlt er dort, auf das provisionierte
// Volume (data/mcp_modules), in dem der Provisioner die npm-Pakete ablegt.
export function resolveStdioCommand(command: string): string {
  if (isAbsolute(command)) return command;
  const rel = command.replace(/^\.\//, '');
  if (!rel.startsWith('node_modules/.bin/')) return command;
  const inApp = resolve(process.cwd(), rel);
  if (existsSync(inApp)) return inApp;
  const provisioned = join(config.mcpModulesDir, rel);
  if (existsSync(provisioned)) return provisioned;
  return command;
}

export interface McpServerContext {
  id: number;
  name: string;
  sideEffect: SideEffect;
  client: McpTransport;
  tools: ToolDef[];
}

export interface McpContext {
  servers: McpServerContext[];
}

// Freschheitsschwelle, ab der beim naechsten Zugriff im Hintergrund neu
// geladen wird. Serve-stale: liefert sofort die letzten bekannten Daten und
// stoesst parallel einen Refresh an -> die naechste Anfrage bekommt frische
// Tools, keine Anfrage wartet auf die MCP-Initialisierung. Bewusst hoch:
// stdio-Clients werden beim Refresh komplett neu gespawnt, zu kleine Werte
// erzeugen dauerhaft Prozess-Churn.
const FRESH_MS = 300_000;
const REFRESH_IN_FLIGHT = new Map<number, Promise<void>>();
// Kaltstart-Guard: parallele Anfragen duerfen denselben Server nicht mehrfach
// initialisieren (sonst doppelte stdio-Prozesse).
const COLD_IN_FLIGHT = new Map<number, Promise<{ client: McpTransport; tools: ToolDef[]; ts: number }>>();
const cache = new Map<number, { client: McpTransport; tools: ToolDef[]; ts: number }>();
// Negativ-Cache: nach einem fehlgeschlagenen Init wird der Server fuer
// mcpFailureTtlMs nicht erneut versucht. Sonst kostet jede Anfrage erneut den
// Init-Timeout (stdio bis 15 s) und reisst das Alexa-Fenster.
const failures = new Map<number, number>();

function stopClient(client: McpTransport | undefined): void {
  if (client && typeof client.stop === 'function') client.stop();
}

export function invalidateMcpCache(): void {
  for (const entry of cache.values()) stopClient(entry.client);
  cache.clear();
  failures.clear();
}

// Beim Shutdown alle offenen stdio-Kinder beenden (SIGTERM/SIGINT in
// server.ts). Ohne das blieben Kindprozesse im Container zurueck.
export function stopAllClients(): void {
  invalidateMcpCache();
}

function parseJsonArray(raw: string | null): string[] {
  try {
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseJsonObject(raw: string | null): Record<string, string> {
  try {
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
  } catch {
    return {};
  }
}

// Nur die Felder, die der Transport braucht; Tests und Aufrufer mit vollen
// McpServerRow-Objekten sind damit kompatibel.
type McpClientRow = {
  transport: 'http' | 'stdio';
  url: string;
  auth_token: string | null;
  command: string | null;
  args: string | null;
  env: string | null;
  headers?: string | null;
};

export function createClient(row: McpClientRow): McpTransport {
  if (row.transport === 'stdio') {
    return new McpStdioClient({
      command: resolveStdioCommand(row.command ?? ''),
      args: parseJsonArray(row.args),
      env: parseJsonObject(row.env),
      initTimeoutMs: config.mcpInitTimeoutMs,
    });
  }
  return new McpClient(row.url, row.auth_token, { headers: parseHeaders(row.headers ?? null) });
}


async function loadServer(row: McpServerRow): Promise<{ client: McpTransport; tools: ToolDef[]; ts: number }> {
  const client = createClient(row);
  await client.init();
  const tools = await client.listTools();
  return { client, tools, ts: Date.now() };
}

async function refreshLater(id: number, row: McpServerRow): Promise<void> {
  if (REFRESH_IN_FLIGHT.has(id)) return REFRESH_IN_FLIGHT.get(id);
  const p = (async () => {
    try {
      const fresh = await loadServer(row);
      const old = cache.get(id);
      if (old) stopClient(old.client);
      cache.set(id, fresh);
    } catch (e) {
      // Fehler beim Refresh: alten Cache unveraendert weiterverwenden
      console.error(`MCP-Refresh ${id} fehlgeschlagen:`, e);
    } finally {
      REFRESH_IN_FLIGHT.delete(id);
    }
  })();
  REFRESH_IN_FLIGHT.set(id, p);
  return p;
}

export async function getMcpContext(): Promise<McpContext> {
  const rows = listMcpServers(true, true);
  // Alle Server parallel: gecachte sofort liefern, Kaltstarts parallel laden
  // (serve-stale-Refresh sowieso). Fehler isoliert pro Server abfangen.
  const results = await Promise.all(
    rows.map(async (row): Promise<McpServerContext | null> => {
      const entry = cache.get(row.id);
      if (entry) {
        if (Date.now() - entry.ts > FRESH_MS) {
          // serve-stale: sofort liefern, Refresh im Hintergrund -> naechste Anfrage frisch
          void refreshLater(row.id, row);
        }
        return { id: row.id, name: row.name, sideEffect: row.side_effect, client: entry.client, tools: entry.tools };
      }
      // Kaltstart: erstmalig laden (blockierend, da Daten zwingend noetig),
      // aber ueber alle Rows parallel statt sequenziell und mit Guard gegen
      // parallele Doppel-Initialisierung.
      const failedAt = failures.get(row.id);
      if (failedAt !== undefined && Date.now() - failedAt < config.mcpFailureTtlMs) {
        return null; // Negativ-Cache: kuerzlich fehlgeschlagen, nicht erneut versuchen
      }
      try {
        let inflight = COLD_IN_FLIGHT.get(row.id);
        if (!inflight) {
          inflight = loadServer(row).finally(() => COLD_IN_FLIGHT.delete(row.id));
          COLD_IN_FLIGHT.set(row.id, inflight);
        }
        const fresh = await inflight;
        cache.set(row.id, fresh);
        failures.delete(row.id);
        return { id: row.id, name: row.name, sideEffect: row.side_effect, client: fresh.client, tools: fresh.tools };
      } catch (e) {
        failures.set(row.id, Date.now());
        console.error(`MCP-Init ${row.id} fehlgeschlagen:`, e);
        return null;
      }
    })
  );
  return { servers: results.filter((s): s is McpServerContext => s !== null) };
}