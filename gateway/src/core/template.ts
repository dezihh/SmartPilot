import nunjucks from 'nunjucks';
import type { McpContext } from '../mcp/registry.js';
import { getIndexSnapshot, listIndexKeys, type IndexEntry } from './entityIndex.js';
import { findInSnapshot, getFromSnapshot } from './indexTools.js';
import { getFunctionByName } from '../db.js';
import { config } from '../config.js';
import type { AssistantResponse, TraceEvent } from '../types.js';
import { extractLiterals } from './extract.js';
import { httpCacheGet, httpCacheSet } from './httpCache.js';
import { fetchUrl } from './http.js';
import { runShell } from './shell.js';


// Kontext fuer Templates. Zeitstempel kommen aus einer expliziten Zeitzone,
// damit der UTC-Container nicht um 6 Uhr UTC "Guten Morgen" sagt.
export function nowContext(
  timeZone: string,
  now: Date = new Date()
): { hour: number; weekday: string; date: string; time: string } {
  return {
    hour: Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(now)),
    weekday: new Intl.DateTimeFormat('de-DE', { timeZone, weekday: 'long' }).format(now),
    date: new Intl.DateTimeFormat('de-DE', { timeZone }).format(now),
    time: new Intl.DateTimeFormat('de-DE', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now),
  };
}

const env = new nunjucks.Environment(null, { autoescape: false });

// Verschachtelungstiefe fuer fn()-Aufrufe; verhindert Zyklen und Runaways.
const FN_MAX_DEPTH = 3;

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

// Ein mcp.call gilt als "leer", wenn das Tool fehlt/fehlschlaegt (null) oder
// keine verwertbare Ausgabe liefert -> genau dann greift der optionale Fallback.
function isBlankMcpResult(text: string | null): boolean {
  return text === null || text.trim() === '';
}

async function invokeTool(
  mcp: McpContext,
  tool: string,
  args: Record<string, unknown>,
  trace: TraceEvent[],
  step: string
): Promise<string | null> {
  const found = findToolExact(mcp, tool);
  if (!found) throw new Error(`Tool ${tool} auf keinem MCP-Server gefunden`);
  const result = await found.server.client.callTool(found.toolName, args);
  trace.push({ ts: Date.now(), step, detail: { tool, server: found.server.name } });
  return extractText(result);
}

// mcp.call mit optionaler Kaskade: Primaer-Tool ausfuehren; nur wenn das leer
// bleibt/fehlschlaegt, wird das Fallback-Tool (gleiche Args) aufgerufen.
async function invokeWithFallback(
  mcp: McpContext,
  tool: string,
  args: Record<string, unknown>,
  fallback: string | undefined,
  trace: TraceEvent[],
  step: string
): Promise<string | null> {
  let text: string | null = null;
  try {
    text = await invokeTool(mcp, tool, args, trace, step);
  } catch (e) {
    trace.push({ ts: Date.now(), step: 'template.mcp.error', detail: { tool, error: String(e) } });
  }
  if (isBlankMcpResult(text) && fallback) {
    try {
      const fb = await invokeTool(mcp, fallback, args, trace, 'template.mcp.fallback');
      if (!isBlankMcpResult(fb)) text = fb;
    } catch (e) {
      trace.push({ ts: Date.now(), step: 'template.mcp.error', detail: { tool: fallback, error: String(e) } });
    }
  }
  return text;
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
  const { usesIndex, states, indexKeys, indexAll, calls, mcpCallDyn, httpCalls, httpDyn, shells, fns } = extractLiterals(template);
  const stateMap = new Map<string, string | null>();
  const callMap = new Map<string, string | null>();
  const shellMap = new Map<string, string | null>();
  const fnMap = new Map<string, string | null>();
  const httpMap = new Map<string, unknown | null>();

  // HTTP-Cache : nur aktiv, wenn der Call eine TTL > 0 mitgibt
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
  // zuerst mit args/now zu einer URL aufgeloest  und dann normal
  // gecacht/geholt. Ausdruck und Ergebnis-URL stimmen zur Render-Zeit wieder
  // ueberein, weil args innerhalb eines Renders konstant sind.
  const nowCtx = nowContext(config.timezone);
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
    callMap.set(normKey, await invokeWithFallback(mcp, call.tool, parsedArgs ?? {}, call.fallback, trace, 'template.mcp'));
  }

  // Dynamische mcp.call-Args (Parallele fuer mcp): die
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
    callMap.set(normKey, await invokeWithFallback(mcp, dyn.tool, parsedArgs, dyn.fallback, trace, 'template.mcp.dyn'));
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
    now: nowCtx,
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
  const out = await renderPlain(template, mcp, trace, 0, new Set(), args);
  if (/^<speak[\s>]/i.test(out)) {
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
