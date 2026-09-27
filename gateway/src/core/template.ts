import nunjucks from 'nunjucks';
import { exec } from 'node:child_process';
import type { McpContext } from '../mcp/registry.js';
import { getIndexSnapshot, listIndexKeys, type IndexEntry } from './entityIndex.js';
import { findInSnapshot, getFromSnapshot } from './indexTools.js';
import { getFunctionByName, getSettingNum } from '../db.js';
import type { AssistantResponse, TraceEvent } from '../types.js';

const env = new nunjucks.Environment(null, { autoescape: false });

// Shell-Helper: admin-only editierbar (Templates), laeuft im Gateway-Container.
// Absicherungen: Timeout + Output-Cap, damit ein haengender Befehl die
// Alexa-Antwort nicht blockiert bzw. den Prompt sprengt.
const SHELL_TIMEOUT_MS = 5000;
const SHELL_OUTPUT_CAP = 4000;
import { extractLiterals, type LiteralCalls } from './extract.js';
import { httpCacheGet, httpCacheSet } from './httpCache.js';


// HTTP-Baustein: generischer GET-Fetch fuer beliebige REST-Endpunkte.
// Absicherungen: Timeout + Groessencap; JSON wird automatisch geparst,
// damit Templates direkt auf Felder zugreifen koennen.
export const HTTP_TIMEOUT_MS = 5000;
export const HTTP_BODY_CAP = 100_000;

// SSRF-Schutz: dynamische http()-URLs (args-kontaminiert) duerfen niemals ins
// private Netz zeigen. Literale URLs (Admin-Templates) sind vertrauenswuerdig
// und bleiben unangetastet (LAN-Dienste wie CGIs muessen funktionieren).
// Haertung: Der URL-Parser kanonisiert IPv4-Kurzformen (Dezimal/Oktal/Hex);
// danach werden private IPv4-/IPv6-Bereiche inkl. IPv4-Mapped geprueft.
function ipv4ToBytes(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

function ipv4InRange(bytes: number[], base: string, bits: number): boolean {
  const b = ipv4ToBytes(base);
  if (!b) return false;
  const n = ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
  const bn = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((n & mask) >>> 0) === ((bn & mask) >>> 0);
}

function isPrivateIpv4(ip: string): boolean {
  const b = ipv4ToBytes(ip);
  if (!b) return false;
  return (
    ipv4InRange(b, '0.0.0.0', 8) ||
    ipv4InRange(b, '10.0.0.0', 8) ||
    ipv4InRange(b, '100.64.0.0', 10) ||
    ipv4InRange(b, '127.0.0.0', 8) ||
    ipv4InRange(b, '169.254.0.0', 16) ||
    ipv4InRange(b, '172.16.0.0', 12) ||
    ipv4InRange(b, '192.0.0.0', 24) ||
    ipv4InRange(b, '192.168.0.0', 16) ||
    ipv4InRange(b, '198.18.0.0', 15)
  );
}

function expandIpv6(input: string): number[] | null {
  let ip = input.replace(/^\[|\]$/g, '').toLowerCase().split('%')[0]!;
  if (!ip.includes(':')) return null;
  const dotIdx = ip.lastIndexOf('.');
  if (dotIdx !== -1) {
    // Eingebettete IPv4-Schreibweise (z. B. ::ffff:127.0.0.1) -> zwei Hextets.
    const colonIdx = ip.lastIndexOf(':');
    const v4 = ipv4ToBytes(ip.slice(colonIdx + 1));
    if (!v4) return null;
    const hi = ((v4[0]! << 8) | v4[1]!).toString(16);
    const lo = ((v4[2]! << 8) | v4[3]!).toString(16);
    ip = `${ip.slice(0, colonIdx + 1)}${hi}:${lo}`;
  }
  const parts = ip.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length === 2 ? (parts[1] ? parts[1].split(':') : []) : [];
  if (parts.length === 1 && head.length !== 8) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  const groups = [...head, ...Array<string>(missing).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}

function isPrivateIpv6(ip: string): boolean {
  const g = expandIpv6(ip);
  if (!g) return false;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return true;
  if ((g0! & 0xffc0) === 0xfe80) return true; // fe80::/10 Link-Local
  if ((g0! & 0xfe00) === 0xfc00) return true; // fc00::/7 Unique Local
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isPrivateIpv4(`${(g6! >> 8) & 0xff}.${g6! & 0xff}.${(g7! >> 8) & 0xff}.${g7! & 0xff}`);
  }
  return false;
}

export function isPrivateHost(hostname: string): boolean {
  let h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  // IPv4-Kurzformen (Dezimal/Oktal/Hex) ueber den URL-Parser kanonisieren.
  try {
    const canon = new URL(`http://${h}`).hostname.replace(/^\[|\]$/g, '');
    if (canon) h = canon;
  } catch {
    /* kein parsbarer Host - mit dem Rohwert weiterpruefen */
  }
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (isPrivateIpv4(h)) return true;
  if (isPrivateIpv6(h)) return true;
  return false;
}

// Body streamend bis zum Cap lesen: eine riesige Antwort darf nicht erst
// komplett in den Speicher geladen werden (Body-Cap greift sonst zu spaet).
async function readCapped(res: Response, cap: number): Promise<string> {
  if (!res.body) return (await res.text()).slice(0, cap);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
      if (out.length >= cap) break;
    }
    out += decoder.decode();
  } catch {
    /* abgebrochene Verbindung: bisher Gelesenes verwenden */
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
  return out.slice(0, cap);
}

async function fetchUrl(url: string, trace: TraceEvent[], dynamic: boolean): Promise<unknown | null> {
  const timeoutMs = getSettingNum('http_timeout_ms', HTTP_TIMEOUT_MS);
  const bodyCap = getSettingNum('http_body_cap', HTTP_BODY_CAP);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let target = url;
    // Dynamische URLs: jede Redirect-Etappe erneut pruefen statt blindem follow,
    // sonst umgeht ein Redirect die Host-Pruefung.
    for (let hop = 0; hop <= 3; hop++) {
      const u = new URL(target);
      if (dynamic && isPrivateHost(u.hostname)) {
        trace.push({ ts: Date.now(), step: 'template.http.blocked', detail: { url: target, reason: 'privates Netz' } });
        return null;
      }
      const res = await fetch(target, { signal: controller.signal, redirect: dynamic ? 'manual' : 'follow' });
      if (dynamic && res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) {
          trace.push({ ts: Date.now(), step: 'template.http.error', detail: { url: target, status: res.status, error: 'Redirect ohne Location' } });
          return null;
        }
        target = new URL(loc, target).toString();
        continue;
      }
      const raw = await readCapped(res, bodyCap);
      if (!res.ok) {
        trace.push({ ts: Date.now(), step: 'template.http.error', detail: { url: target, status: res.status, body: raw.slice(0, 200) } });
        return null;
      }
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return raw;
      }
    }
    trace.push({ ts: Date.now(), step: 'template.http.error', detail: { url, error: 'zu viele Redirects' } });
    return null;
  } catch (e) {
    trace.push({ ts: Date.now(), step: 'template.http.error', detail: { url, error: String(e) } });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Verschachtelungstiefe fuer fn()-Aufrufe; verhindert Zyklen und Runaways.
const FN_MAX_DEPTH = 3;

function runShell(cmd: string, trace: TraceEvent[]): Promise<string | null> {
  return new Promise((resolve) => {
    exec(
      cmd,
      { timeout: SHELL_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          trace.push({
            ts: Date.now(),
            step: 'template.shell.error',
            detail: { cmd, error: String(err.message).slice(0, 300), stderr: String(stderr).slice(0, 300) },
          });
          return resolve(null);
        }
        const out = `${stdout}`.trim().slice(0, SHELL_OUTPUT_CAP);
        trace.push({ ts: Date.now(), step: 'template.shell', detail: { cmd, chars: out.length } });
        resolve(out);
      }
    );
  });
}

function findToolExact(
  mcp: McpContext,
  toolName: string
): { server: McpContext['servers'][number]; toolName: string } | undefined {
  for (const server of mcp.servers) {
    const tool = server.tools.find((t) => t.name === toolName);
    if (tool) return { server, toolName: tool.name };
  }
  return undefined;
}

// mcp.call-Args: flaches JSON-Literal im Template; einzelne Anfuehrungs-
// striche (Jinja-Stil) werden tolerant auf doppelte gemappt.
function parseCallArgs(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  for (const candidate of [raw, raw.replace(/'/g, '"')]) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // naechste Variante
    }
  }
  return null;
}

function extractText(result: unknown): string {
  if (result && typeof result === 'object') {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      return content
        .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : ''))
        .filter(Boolean)
        .join('\n');
    }
    return JSON.stringify(result);
  }
  return String(result ?? '');
}

interface UnwrappedSpeech {
  text: string;
  ssml: boolean;
}

function unwrapSpeech(value: unknown): UnwrappedSpeech | null {
  if (typeof value === 'string') return { text: value, ssml: false };
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const ssml = obj.ssml;
    if (typeof ssml === 'string') return { text: ssml, ssml: true };
    if (ssml && typeof ssml === 'object') {
      const inner = (ssml as Record<string, unknown>).speech;
      if (typeof inner === 'string') return { text: inner, ssml: true };
    }
    if (typeof obj.speech === 'string') return { text: obj.speech, ssml: false };
  }
  return null;
}

async function preheat(
  template: string,
  mcp: McpContext,
  trace: TraceEvent[],
  depth: number,
  active: Set<string>,
  args: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const { usesIndex, states, indexKeys, indexAll, calls, mcpCallDyn, httpCalls, httpDyn, shells, fns, httpUrls } = extractLiterals(template);
  const stateMap = new Map<string, string | null>();
  const callMap = new Map<string, string | null>();
  const shellMap = new Map<string, string | null>();
  const fnMap = new Map<string, string | null>();
  const httpMap = new Map<string, unknown | null>();

  // HTTP-Cache (Finding #7): nur aktiv, wenn der Call eine TTL > 0 mitgibt
  // (http('url', 300000)). Cache lebt pro URL im Prozess, laeuft mit eigener TTL ab.
  const fetchCached = async (url: string, ttl: number, dynamic: boolean): Promise<unknown | null> => {
    if (ttl > 0) {
      const hit = httpCacheGet(url);
      if (hit !== null) {
        trace.push({ ts: Date.now(), step: 'template.http.cache', detail: { url } });
        return hit;
      }
    }
    const data = await fetchUrl(url, trace, dynamic);
    if (ttl > 0 && data !== null) httpCacheSet(url, data, ttl);
    return data;
  };

  // HTTP-URLs parallel laden (dedupliziert); dynamische Expressionen werden
  // zuerst mit args/now zu einer URL aufgeloest (Finding #1) und dann normal
  // gecacht/geholt. Ausdruck und Ergebnis-URL stimmen zur Render-Zeit wieder
  // ueberein, weil args innerhalb eines Renders konstant sind.
  const nowCtx = {
    hour: new Date().getHours(),
    weekday: new Date().toLocaleDateString('de-DE', { weekday: 'long' }),
    date: new Date().toLocaleDateString('de-DE'),
    time: new Date().toTimeString().slice(0, 5),
  };
  const dynUrls = await Promise.all(
    httpDyn.map(async (d) => {
      try {
        const url = env.renderString(`{{ ${d.expr} }}`, { args, now: nowCtx }).trim();
        return /^https?:\/\//.test(url) ? { url, ttl: d.ttl } : null;
      } catch (e) {
        trace.push({ ts: Date.now(), step: 'template.http.expr.error', detail: { expr: d.expr, error: String(e).slice(0, 200) } });
        return null;
      }
    })
  );
  const httpJobs: { url: string; ttl: number; dynamic: boolean }[] = [
    ...httpCalls.map((c) => ({ ...c, dynamic: false })),
    ...dynUrls.filter((d): d is { url: string; ttl: number } => d !== null).map((d) => ({ ...d, dynamic: true })),
  ];
  await Promise.all(
    httpJobs.map(async (job) => {
      if (httpMap.has(job.url)) return;
      httpMap.set(job.url, await fetchCached(job.url, job.ttl, job.dynamic));
      trace.push({ ts: Date.now(), step: 'template.http', detail: { url: job.url } });
    })
  );

  // Entity-Index(e) nur bei Bedarf vorwaermen - Basis fuer index.find/index.get/index.state.
  // Mehrere Keys parallel (Multi-Index: '' = Default, z. B. 'ma' = Music Assistant).
  // indexAll = Key faellt erst zur Renderzeit aus args -> alle konfigurierten Keys vorwaermen.
  const snapshotFor = new Map<string, IndexEntry[]>();
  const preheatKeys = indexAll ? listIndexKeys() : indexKeys;
  if (usesIndex || preheatKeys.length > 0) {
    await Promise.all(
      [...new Set(preheatKeys)].map(async (key) => {
        try {
          snapshotFor.set(key, await getIndexSnapshot(key));
        } catch (e) {
          trace.push({ ts: Date.now(), step: 'template.index.error', detail: { index: key, error: String(e) } });
          snapshotFor.set(key, []);
        }
      })
    );
  }
  const indexFind = (query: string, key = ''): string => findInSnapshot(snapshotFor.get(key) ?? [], query, 8, key);
  const indexGet = (entityId: string, key = ''): string => getFromSnapshot(snapshotFor.get(key) ?? [], entityId, key);

  for (const name of fns) {
    if (fnMap.has(name)) continue;
    if (active.has(name) || depth >= FN_MAX_DEPTH) {
      trace.push({
        ts: Date.now(),
        step: 'fn.error',
        detail: { name, reason: active.has(name) ? 'zyklus' : `tiefe > ${FN_MAX_DEPTH}` },
      });
      fnMap.set(name, null);
      continue;
    }
    const row = getFunctionByName(name);
    if (!row) {
      trace.push({ ts: Date.now(), step: 'fn.error', detail: { name, reason: 'unbekannt oder inaktiv' } });
      fnMap.set(name, null);
      continue;
    }
    try {
      active.add(name);
      const rendered = await renderPlain(row.template, mcp, trace, depth + 1, active);
      active.delete(name);
      fnMap.set(name, rendered);
      trace.push({ ts: Date.now(), step: 'fn.render', detail: { name, chars: rendered.length } });
    } catch (e) {
      active.delete(name);
      trace.push({ ts: Date.now(), step: 'fn.error', detail: { name, error: String(e) } });
      fnMap.set(name, null);
    }
  }

  for (const call of calls) {
    // Normalisierter Key (geparste Args) = Lookup-Schluessel im Template-ctx;
    // identische Aufrufe mit gleichem Tool+Args werden dedupliziert.
    const parsedArgs = parseCallArgs(call.args);
    const normKey = `${call.tool}|${parsedArgs ? JSON.stringify(parsedArgs) : ''}`;
    if (callMap.has(normKey)) continue;
    try {
      const found = findToolExact(mcp, call.tool);
      if (!found) throw new Error(`Tool ${call.tool} auf keinem MCP-Server gefunden`);
      const result = await found.server.client.callTool(found.toolName, parsedArgs ?? {});
      callMap.set(normKey, extractText(result));
      trace.push({ ts: Date.now(), step: 'template.mcp', detail: { tool: call.tool, server: found.server.name } });
    } catch (e) {
      trace.push({ ts: Date.now(), step: 'template.mcp.error', detail: { tool: call.tool, error: String(e) } });
      callMap.set(normKey, null);
    }
  }

  // Dynamische mcp.call-Args (Finding #1-Parallele fuer mcp): die
  // Args-Expression wird mit args/now zu einem JSON-Objekt evaluiert
  // (nunjucks '| dump'), live gecallt und unter dem normalisierten Key
  // gecacht - der Render lookup trifft denselben Key.
  for (const dyn of mcpCallDyn) {
    let parsedArgs: Record<string, unknown> | null = null;
    try {
      const json = env.renderString(`{{ (${dyn.expr}) | dump }}`, { args, now: nowCtx }).trim();
      const parsed = JSON.parse(json) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        parsedArgs = parsed as Record<string, unknown>;
      }
    } catch (e) {
      trace.push({ ts: Date.now(), step: 'template.mcp.expr.error', detail: { tool: dyn.tool, error: String(e).slice(0, 200) } });
      continue;
    }
    if (!parsedArgs) continue;
    const normKey = `${dyn.tool}|${JSON.stringify(parsedArgs)}`;
    if (callMap.has(normKey)) continue;
    try {
      const found = findToolExact(mcp, dyn.tool);
      if (!found) throw new Error(`Tool ${dyn.tool} auf keinem MCP-Server gefunden`);
      const result = await found.server.client.callTool(found.toolName, parsedArgs);
      callMap.set(normKey, extractText(result));
      trace.push({ ts: Date.now(), step: 'template.mcp.dyn', detail: { tool: dyn.tool, server: found.server.name } });
    } catch (e) {
      trace.push({ ts: Date.now(), step: 'template.mcp.error', detail: { tool: dyn.tool, error: String(e) } });
      callMap.set(normKey, null);
    }
  }

  for (const { id, key } of states) {
    const mapKey = `${key}\u0000${id}`;
    if (stateMap.has(mapKey)) continue;
    try {
      const entity = snapshotFor.get(key)?.find((e) => e.id === id);
      if (!entity) throw new Error(`Entity ${id} nicht gefunden (Index ${key || 'default'})`);
      stateMap.set(mapKey, entity.state);
      trace.push({ ts: Date.now(), step: 'template.state', detail: { entityId: id, index: key } });
    } catch (e) {
      trace.push({ ts: Date.now(), step: 'template.state.error', detail: { entityId: id, index: key, error: String(e) } });
      stateMap.set(mapKey, null);
    }
  }

  for (const cmd of shells) {
    if (shellMap.has(cmd)) continue;
    shellMap.set(cmd, await runShell(cmd, trace));
  }

  return {
    args,
    index: {
      // 2. Argument = Index-Key ('' = Default-Index, z. B. 'ma' = Music Assistant)
      state: (entityId: string, key = ''): string | null => stateMap.get(`${key ?? ''}\u0000${entityId}`) ?? null,
      get: (entityId: string, key = ''): string => indexGet(entityId, key ?? ''),
      find: (query: string, key = ''): string => indexFind(String(query ?? ''), key ?? ''),
    },
    mcp: {
      // Bewusst Objekt (nicht Funktion): mcp.call(...) im Template wuerde
      // sonst Function.prototype.call statt der Lookup-Funktion aufrufen.
      call: (tool: string, callArgs?: Record<string, unknown>): string | null =>
        callMap.get(`${tool}|${callArgs ? JSON.stringify(callArgs) : ''}`) ?? null,
    },
    shell: (cmd: string): string | null => shellMap.get(cmd) ?? null,
    fn: (name: string): string | null => fnMap.get(name) ?? null,
    http: (url: string): unknown | null => httpMap.get(url) ?? null,
    now: (() => {
      const d = new Date();
      return { hour: d.getHours(), weekday: d.toLocaleDateString('de-DE', { weekday: 'long' }), date: d.toLocaleDateString('de-DE'), time: d.toTimeString().slice(0, 5) };
    })(),
  };
}

async function renderPlain(
  template: string,
  mcp: McpContext,
  trace: TraceEvent[],
  depth: number,
  active: Set<string>,
  args: Record<string, unknown> = {}
): Promise<string> {
  const ctx = await preheat(template, mcp, trace, depth, active, args);
  return env.renderString(template, ctx).trim();
}

// Rendert eine Funktion aus der Registry (function_ref am Vorgang oder
// als LLM-Tool-Aufruf mit Argumenten, die als args zur Verfuegung stehen).
export async function renderFunction(
  name: string,
  mcp: McpContext,
  trace: TraceEvent[],
  args: Record<string, unknown> = {}
): Promise<AssistantResponse> {
  const row = getFunctionByName(name);
  if (!row) throw new Error(`Funktion ${name} nicht gefunden oder inaktiv`);
  return renderActionTemplate(row.template, mcp, trace, args);
}

export async function renderActionTemplate(
  template: string,
  mcp: McpContext,
  trace: TraceEvent[],
  args: Record<string, unknown> = {}
): Promise<AssistantResponse> {
  const out = await renderPlain(template, mcp, trace, 0, new Set(), args);  if (/^<speak[\s>]/i.test(out)) {
    return { speech: out, ssml: true };
  }
  if (out.startsWith('{')) {
    try {
      const parsed = JSON.parse(out) as { speech?: unknown; display?: AssistantResponse['display'] };
      const unwrapped = unwrapSpeech(parsed.speech);
      if (unwrapped) {
        return {
          speech: unwrapped.text,
          ...(unwrapped.ssml ? { ssml: true } : {}),
          ...(parsed.display ? { display: parsed.display } : {}),
        };
      }
    } catch {
      return { speech: out };
    }
  }
  return { speech: out };
}
