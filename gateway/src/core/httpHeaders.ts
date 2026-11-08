// Header-Auth fuer den http()-Baustein: Ziel -> Header.
// Bewusst exakte Ziele (host bzw. host:port), keine Wildcards: ein Header mit
// Geheimnis darf nie an einen anderen Host gehen, auch nicht nach einem
// Redirect. Die Werte werden nie geloggt.

export type HeaderMap = Map<string, Record<string, string>>;

// Gleiche Namensregel wie bei den MCP-Servern (normalize.ts).
const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/;
const HOST_KEY_RE = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/;

function checkPort(port: string | undefined): void {
  if (port === undefined) return;
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`ungueltiger Port "${port}"`);
}

function checkHostKey(key: string): void {
  const m = HOST_KEY_RE.exec(key);
  if (!m) throw new Error(`ungueltiger Host "${key}"`);
  checkPort(m[2]);
}

function checkHeaderValue(name: string, value: string, host: string): void {
  if (/[\r\n\0]/.test(value)) throw new Error(`Wert fuer "${name}" (${host}) enthaelt Steuerzeichen`);
}

/** JSON-Objekt { "host[:port]": { "Header": "Wert" } } -> Map. Wirft bei Fehlern. */
export function parseHttpHeaders(raw: string | undefined | null): HeaderMap {
  const out: HeaderMap = new Map();
  if (raw == null || !raw.trim()) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('http_headers: ungueltiges JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('http_headers: JSON-Objekt erwartet');
  }
  for (const [rawHost, rawHeaders] of Object.entries(parsed as Record<string, unknown>)) {
    const host = rawHost.trim().toLowerCase();
    checkHostKey(host);
    if (!rawHeaders || typeof rawHeaders !== 'object' || Array.isArray(rawHeaders)) {
      throw new Error(`http_headers: Header-Objekt fuer "${host}" erwartet`);
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(rawHeaders as Record<string, unknown>)) {
      if (!HEADER_NAME_RE.test(name)) throw new Error(`http_headers: ungueltiger Header-Name "${name}" (${host})`);
      if (typeof value !== 'string') throw new Error(`http_headers: Wert fuer "${name}" (${host}) muss String sein`);
      checkHeaderValue(name, value, host);
      headers[name] = value;
    }
    if (Object.keys(headers).length) out.set(host, headers);
  }
  return out;
}

/** Header fuer genau dieses Ziel: host:port gewinnt vor host. */
export function headersForUrl(url: URL, map: HeaderMap): Record<string, string> {
  if (map.size === 0) return {};
  const host = url.hostname.toLowerCase();
  if (url.port) {
    const exact = map.get(`${host}:${url.port}`);
    if (exact) return exact;
  }
  return map.get(host) ?? {};
}

/** Komma-/Zeilenliste exakter Hosts, die dynamische http()-Ziele ins LAN lassen. */
export function parsePrivateAllow(raw: string | undefined | null): Set<string> {
  const out = new Set<string>();
  if (raw == null || !raw.trim()) return out;
  for (const part of raw.split(/[\s,]+/)) {
    const key = part.trim().toLowerCase();
    if (!key) continue;
    checkHostKey(key);
    out.add(key);
  }
  return out;
}

export function isAllowedPrivateTarget(url: URL, allow: Set<string>): boolean {
  if (allow.size === 0) return false;
  const host = url.hostname.toLowerCase();
  if (url.port && allow.has(`${host}:${url.port}`)) return true;
  return allow.has(host);
}
