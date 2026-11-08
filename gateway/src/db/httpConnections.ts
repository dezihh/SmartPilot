import { getDb } from './schema.js';
import type { HttpConnectionRow } from '../types.js';

export interface HttpConnectionInput {
  name: string;
  base_url: string;
  headers: string | null;
  allow_private: number;
  timeout_ms: number | null;
  description: string | null;
  enabled: number;
}

// Header koennen Secrets tragen (API-Key, Bearer): in der Admin-API nur die
// Praesenz zeigen, nie den Wert.
export function maskHttpConnectionSecrets(row: HttpConnectionRow): HttpConnectionRow {
  return { ...row, headers: null };
}

export function listHttpConnections(enabledOnly: boolean, reveal = false): HttpConnectionRow[] {
  const rows = enabledOnly
    ? (getDb().prepare('SELECT * FROM http_connections WHERE enabled = 1 ORDER BY name').all() as HttpConnectionRow[])
    : (getDb().prepare('SELECT * FROM http_connections ORDER BY name').all() as HttpConnectionRow[]);
  return reveal ? rows : rows.map(maskHttpConnectionSecrets);
}

export function getHttpConnection(id: number): HttpConnectionRow | undefined {
  return getDb().prepare('SELECT * FROM http_connections WHERE id = ?').get(id) as HttpConnectionRow | undefined;
}

/** Laufzeitpfad: Header im Klartext, nur fuer den Request selbst. */
export function getHttpConnectionByName(name: string): HttpConnectionRow | undefined {
  return getDb().prepare('SELECT * FROM http_connections WHERE name = ?').get(name) as HttpConnectionRow | undefined;
}

export function createHttpConnection(data: HttpConnectionInput): HttpConnectionRow {
  const info = getDb()
    .prepare(
      `INSERT INTO http_connections (name, base_url, headers, allow_private, timeout_ms, description, enabled)
       VALUES (@name, @base_url, @headers, @allow_private, @timeout_ms, @description, @enabled)`
    )
    .run(data);
  return getHttpConnection(Number(info.lastInsertRowid)) as HttpConnectionRow;
}

export function updateHttpConnection(
  id: number,
  data: HttpConnectionInput,
  clearHeaders = false
): HttpConnectionRow | undefined {
  // Leeres/maskiertes Header-Feld behaelt den bestehenden Wert; {} loescht ihn.
  const headers = clearHeaders ? 'NULL' : 'COALESCE(@headers, headers)';
  getDb()
    .prepare(
      `UPDATE http_connections SET name = @name, base_url = @base_url, headers = ${headers},
       allow_private = @allow_private, timeout_ms = @timeout_ms, description = @description, enabled = @enabled
       WHERE id = @id`
    )
    .run({ ...data, id });
  return getHttpConnection(id);
}

export function deleteHttpConnection(id: number): void {
  getDb().prepare('DELETE FROM http_connections WHERE id = ?').run(id);
}
