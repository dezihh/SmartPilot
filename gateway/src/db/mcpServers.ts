import { getDb } from './schema.js';
import type { McpServerRow, SideEffect } from '../types.js';

export interface McpServerInput {
  name: string;
  url: string;
  auth_token: string | null;
  transport: 'http' | 'stdio';
  command: string | null;
  args: string | null;
  env: string | null;
  inventory_prompt: string | null;
  side_effect?: SideEffect;
  enabled: number;
}

export function listMcpServers(enabledOnly: boolean, reveal = false): McpServerRow[] {
  const rows = enabledOnly
    ? (getDb().prepare('SELECT * FROM mcp_servers WHERE enabled = 1').all() as McpServerRow[])
    : (getDb().prepare('SELECT * FROM mcp_servers ORDER BY name').all() as McpServerRow[]);
  // Token standardmaessig fuer die Admin-API maskieren; nur interne Nutzer
  // (MCP-Aufbau, Backup mit explizitem Wunsch) fordern Klartext an.
  return reveal ? rows : rows.map((r) => ({ ...r, auth_token: null }));
}

export function getMcpServer(id: number): McpServerRow | undefined {
  return getDb().prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as McpServerRow | undefined;
}

export function createMcpServer(data: McpServerInput): McpServerRow {
  const info = getDb().prepare(
      `INSERT INTO mcp_servers (name, url, auth_token, transport, command, args, env, inventory_prompt, side_effect, enabled)
       VALUES (@name, @url, @auth_token, @transport, @command, @args, @env, @inventory_prompt, @side_effect, @enabled)`
    )
    .run({ ...data, side_effect: data.side_effect ?? 'write' });
  return getMcpServer(Number(info.lastInsertRowid)) as McpServerRow;
}

export function updateMcpServer(id: number, data: McpServerInput): McpServerRow | undefined {
  // auth_token = COALESCE: null (Feld im UI leer gelassen) beibehält den
  // bestehenden Token statt ihn zu wischen (PUT ist sonst ein Full-Replace).
  getDb().prepare(
    `UPDATE mcp_servers SET name = @name, url = @url,
     auth_token = COALESCE(@auth_token, auth_token), transport = @transport,
     command = @command, args = @args, env = @env, inventory_prompt = @inventory_prompt, side_effect = @side_effect, enabled = @enabled WHERE id = @id`
  ).run({ ...data, side_effect: data.side_effect ?? 'write', id });
  return getMcpServer(id);
}

export function deleteMcpServer(id: number): void {
  getDb().prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
}
