// Benannte HTTP-Verbindungen: Base-URL + Header + explizite LAN-Freigabe.
// Der Host ist durch die Verbindung fixiert; Pfade koennen ihn nicht verlassen.
// Secrets bleiben in der DB und werden nur fuer den Request selbst gelesen.
import type { TraceEvent } from '../types.js';
import { getHttpConnectionByName } from '../db/httpConnections.js';
import { fetchHttp } from './http.js';
import { normalizeHeaders, parseHeaders } from './normalize.js';
import { isPrivateHost } from './ssrf.js';

export interface HttpConnectionInput {
  name: string;
  base_url: string;
  headers: string | null;
  allow_private: number;
  timeout_ms: number | null;
  description: string | null;
  enabled: number;
}

export interface ConnectionRequestOptions {
  method?: unknown;
  headers?: unknown;
  body?: unknown;
  query?: unknown;
  ttlMs?: unknown;
}

export function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('base_url: gueltige http(s)-URL erwartet');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('base_url: nur http/https');
  if (url.username || url.password) throw new Error('base_url: Zugangsdaten gehoeren in headers, nicht in die URL');
  if (url.search || url.hash) throw new Error('base_url: ohne Query/Fragment');
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

export function normalizeHttpConnectionInput(body: Record<string, unknown>): HttpConnectionInput {
  const name = String(body.name ?? '').trim().toLowerCase();
  if (!/^[a-z0-9_]{2,40}$/.test(name)) throw new Error('name: 2-40 Zeichen, nur a-z, 0-9, _');
  const baseUrl = normalizeBaseUrl(String(body.base_url ?? ''));
  const allowPrivate =
    body.allow_private === true || body.allow_private === 1 || body.allow_private === '1' ? 1 : 0;
  if (isPrivateHost(new URL(baseUrl).hostname) && !allowPrivate) {
    throw new Error('base_url zeigt ins private Netz; allow_private muss ausdruecklich gesetzt sein');
  }
  let timeout: number | null = null;
  if (body.timeout_ms != null && String(body.timeout_ms).trim() !== '') {
    const n = Number(body.timeout_ms);
    if (!Number.isInteger(n) || n < 100 || n > 60_000) throw new Error('timeout_ms: 100-60000 oder leer');
    timeout = n;
  }
  return {
    name,
    base_url: baseUrl,
    headers: normalizeHeaders(body.headers),
    allow_private: allowPrivate,
    timeout_ms: timeout,
    description: body.description == null ? null : String(body.description).trim() || null,
    enabled: body.enabled === false || body.enabled === 0 || body.enabled === '0' ? 0 : 1,
  };
}

/** Baut die Ziel-URL aus Base + Pfad und haelt sie auf der Base-Origin. */
export function buildConnectionUrl(baseUrl: string, path: string): URL {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
    throw new Error('path muss mit genau einem / beginnen');
  }
  if (/[\r\n\0]/.test(path)) throw new Error('path enthaelt Steuerzeichen');
  const base = new URL(baseUrl);
  const prefix = base.pathname.replace(/\/+$/, '');
  const url = new URL(prefix + path, base);
  if (url.origin !== base.origin) throw new Error('path verlaesst die Verbindungs-Origin');
  if (prefix && !url.pathname.startsWith(prefix + '/') && url.pathname !== prefix) {
    throw new Error('path verlaesst das Base-Prefix');
  }
  return url;
}

function bodyString(body: unknown): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  return JSON.stringify(body);
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((h) => h.toLowerCase() === name.toLowerCase());
}

export async function runConnectionRequest(
  name: string,
  path: string,
  opts: ConnectionRequestOptions,
  trace: TraceEvent[]
): Promise<unknown | null> {
  const method = String(opts.method ?? 'GET').toUpperCase();
  try {
    const row = getHttpConnectionByName(String(name));
    if (!row) throw new Error(`HTTP-Verbindung "${String(name)}" unbekannt`);
    if (!row.enabled) throw new Error(`HTTP-Verbindung "${row.name}" ist deaktiviert`);
    const base = new URL(row.base_url);
    if (isPrivateHost(base.hostname) && !row.allow_private) {
      throw new Error(`HTTP-Verbindung "${row.name}" hat keine LAN-Freigabe`);
    }
    const url = buildConnectionUrl(row.base_url, path);
    if (opts.query !== undefined && opts.query !== null) {
      if (typeof opts.query !== 'object' || Array.isArray(opts.query)) throw new Error('query muss ein Objekt sein');
      for (const [key, value] of Object.entries(opts.query as Record<string, unknown>)) {
        if (value === undefined || value === null) continue;
        if (typeof value === 'object') throw new Error(`query.${key} muss ein Skalar sein`);
        url.searchParams.set(key, String(value));
      }
    }
    const headers = parseHeaders(row.headers);
    if (opts.headers !== undefined && opts.headers !== null) {
      const extra = normalizeHeaders(opts.headers);
      Object.assign(headers, parseHeaders(extra));
    }
    const body = bodyString(opts.body);
    if (body !== undefined && !hasHeader(headers, 'content-type')) headers['Content-Type'] = 'application/json';
    const data = await fetchHttp(
      url.toString(),
      {
        method,
        headers,
        body,
        sameOrigin: base.origin,
        timeoutMs: row.timeout_ms ?? undefined,
        useGlobalHeaders: false,
      },
      trace,
      false
    );
    trace.push({
      ts: Date.now(),
      step: 'template.http.connection',
      detail: { connection: row.name, method, path },
    });
    return data;
  } catch (e) {
    trace.push({
      ts: Date.now(),
      step: 'template.http.connection.error',
      detail: { connection: String(name), method, error: String(e) },
    });
    return null;
  }
}
