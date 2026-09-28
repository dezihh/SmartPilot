import { config } from '../config.js';
import {
  addLog,
  listActions,
  listFunctions,
  getFunctionByName,
  getPrompt,
  getSetting,
  getSettingNum,
  recentAgentTurns,
} from '../db.js';
import { chatCompletion, type ChatCompletionResult, type ChatMessage, type ToolSpec } from '../llm/client.js';
import { getMcpContext, type McpContext } from '../mcp/registry.js';
import { routeAction, type RouteMatch } from './router.js';
import { renderFunction } from './template.js';
import { extractLiterals } from './extract.js';
import { buildInventoryPrompt } from './inventory.js';
import { renderHelpCatalog, renderHelpFallback } from './help.js';
import { escapeXml, stripSsmlTags, withSsmlBreaks, withDisplay, parseAgentAnswer } from './response.js';
import { buildTools, type ToolRoute } from './tools.js';
import { findIndexEntries, getIndexEntry } from './indexTools.js';
import { invalidateIndex } from './entityIndex.js';
import { traceUsage, sumUsageFromTrace } from './usage.js';
import { priorTurns as sessionPriorTurns, rememberTurn as sessionRememberTurn, isChatSession as sessionIsChat, setChatMode } from './session.js';
import type {
  AssistantResponse,
  EngineResult,
  ParsedAction,
  TraceEvent,
  VoiceQuery,
} from '../types.js';

const FallbackError = 'Entschuldigung, da ist etwas schiefgelaufen.';

// Budget fuer die Hilfe-Formulierung: Reasoning-Modelle verbrauchen einen Teil
// der Tokens fuers Nachdenken - zu knapp bemessen kam sonst leerer content.
const HELP_MAX_TOKENS = 4000;

// Kontext-Tiefe für Folgefragen (Grundeinstellungen): memory_turns =
// Wie viele vorangegangene Turns das LLM sieht (In-Memory UND DB-Recall),
// memory_minutes = Wie weit der DB-Recall über Session-Grenzen zurückreicht.
function memoryTurns(): number {
  return getSettingNum('memory_turns', 4);
}

function memoryMinutes(): number {
  return getSettingNum('memory_minutes', 30);
}

function priorTurns(sessionId: string): ChatMessage[] {
  const maxTurns = memoryTurns();
  const inMem = sessionPriorTurns(sessionId, maxTurns * 2);
  if (inMem.length > 0) return inMem;
  // DB-Recall als ALT markieren: Das LLM weiss, dass die Zeit fortgeschritten
  // ist, und kann selbst entscheiden, ob der Inhalt noch relevant ist.
  const turns = recentAgentTurns(maxTurns, memoryMinutes() * 60_000);
  if (turns.length === 0) return [];
  const ageHits = turns.filter((t) => t.ageMs > 5 * 60_000);
  const out: ChatMessage[] = [];
  if (ageHits.length > 0) {
    const detail = ageHits
      .map((t) => `${Math.round(t.ageMs / 60000)} min: ${t.response.slice(0, 80)}`)
      .join('; ');
    out.push({
      role: 'system',
      content: `Hinweis: Es gibt fruehere Unterhaltungen aus anderen Sitzungen (${detail}). Erwaehne sie NICHT als Teil der aktuellen Frage und traue ihrem Inhalt NICHT als aktuellen Stand. Nutze sie nur, wenn sie fuer die aktuelle Frage klar relevant sind.`,
    });
  }
  for (const t of turns) {
    // Trim: SSML-Berichte als Klartext, begrenzt - der Recall soll
    // Kontext liefern, nicht den Prompt sprengen (Prompt-Größe = Rundenzeit).
    out.push({ role: 'user', content: t.query.slice(0, 300) });
    out.push({ role: 'assistant', content: stripSsmlTags(t.response).slice(0, 600) });
  }
  return out;
}

function rememberTurn(sessionId: string, query: string, speech: string): void {
  sessionRememberTurn(sessionId, query, speech, Date.now(), memoryTurns() * 2);
}

const toolDeadline = (): number => getSettingNum('tool_deadline_ms', config.toolDeadlineMs);

function assistantName(): string {
  return getSetting('assistant_name') ?? 'Dein SmartPilot';
}

function promptWithName(key: string): string | undefined {
  const raw = getPrompt(key);
  return raw?.replaceAll('{assistant_name}', assistantName());
}

// System-Prompt fuer den Agenten: agent_system + generiertes Tool-Inventory
// (Werkzeuge aus den Funktionen + agent_inventory-Regeln); die Systeme-Noten
// werden auf die aktiv angebotenen Systeme gefiltert.
function agentSystemPrompt(mcp: McpContext, allowlist: string[] | null = null): string {
  const sys = promptWithName('agent_system') ?? '';
  const inv = buildInventoryPrompt(activeServerNames(mcp, allowlist));
  if (!inv) return sys;
  return `${sys}\n\n## Tool-Inventory (Nachschlagewerk)\n${inv}`;
}

// Systeme-Noten nur fuer die Systeme, deren Tools die aktive Allowlist
// anbietet (null = alle, [] = keine). Vorgaenge ohne Tools (z. B. hilfe)
// sparen damit die komplette Systeme-Sektion.
function activeServerNames(mcp: McpContext, allowlist: string[] | null): string[] | null {
  if (allowlist === null) return null;
  const out: string[] = [];
  for (const s of mcp.servers) {
    if (s.tools.some((t) => allowlist.includes(t.name))) out.push(s.name);
  }
  return out;
}

async function runToolLoop(
  system: string,
  queryText: string,
  mcp: McpContext,
  trace: TraceEvent[],
  sessionId: string,
  allowlist: string[] | null = null
): Promise<AssistantResponse> {
  const { specs, routes, budgets } = buildTools(mcp, allowlist);
  // Tool-Runden mit eigenem (schnellen) Modell: Setting 'tool_model';
  // leer = llm_model wie bisher.
  const roundModel = getSetting('tool_model')?.trim() || undefined;
  const history = sessionId ? priorTurns(sessionId) : [];
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    ...history,
    { role: 'user', content: queryText },
  ];
  const overallDeadline = Date.now() + toolDeadline() * 2;
  const TimeoutAnswer = 'Das hat gerade zu lange gedauert, bitte versuche es gleich noch einmal.';
  // Budgets: DB-Budgets der Funktionen (budget-Spalte) gewinnen, dann die
  // Code-Defaults unten. (Das fruehere Setting 'tool_budgets' ist entfernt:
  // es referenzierte Raw-MCP-Tool-Namen, die nicht mehr im Agent-Katalog sind.)
  const toolBudgets: Record<string, number> = { fn_find_entities: 2, fn_get_entity: 3 };
  const budgetFor = (name: string): number | undefined =>
    budgets.get(name) ?? toolBudgets[name];
  const toolCalls: Record<string, number> = {};
  const runTools = async (message: ChatMessage): Promise<void> => {
    messages.push({
      role: 'assistant',
      content: message.content ?? null,
      ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
      ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
    });
    const results = await Promise.all(
      (message.tool_calls ?? []).map(async (call) => {
        let result: string;
        try {
          const route = routes.get(call.function.name);
          if (!route) throw new Error(`unbekanntes Tool: ${call.function.name}`);
          const used = toolCalls[call.function.name] ?? 0;
          const budget = budgetFor(call.function.name);
          if (budget !== undefined && used >= budget) {
            result = `Limit erreicht (${call.function.name}: max. ${budget} pro Frage). Antworte JETZT mit den vorhandenen Informationen.`;
            trace.push({
              ts: Date.now(),
              step: 'tool.budget_hit',
              detail: { tool: call.function.name, used },
            });
            return { id: call.id, content: result };
          }
          toolCalls[call.function.name] = used + 1;
          const args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
          if (typeof args.num_results === 'number' && args.num_results > 3) {
            args.num_results = 3;
          }
          const out =
            route.kind === 'function'
              ? await (async () => {
                  const resp = await renderFunction(route.name, mcp, trace, args);
                  return { bericht: (resp.ssml ? stripSsmlTags(resp.speech) : resp.speech).slice(0, 4000) };
                })()
              : route.kind === 'index_find'
                ? { bericht: await findIndexEntries(String(args.query ?? ''), typeof args.index === 'string' ? args.index : '') }
                : route.kind === 'index_get'
                  ? { bericht: await getIndexEntry(String(args.key ?? ''), typeof args.index === 'string' ? args.index : '') }
                  : await route.client.callTool(route.toolName, args);
          result = JSON.stringify(out).slice(0, 2000);
          // Schreibvorgaenge koennen den Index-Zustand veraendern (z. B.
          // ha_call_service): nach jedem schreibenden MCP-/Funktions-Call den
          // Index-Cache verwerfen. Lesende Tools (side_effect 'read') und die
          // Basis-Lesetools (index_find/index_get) lassen den Cache unberuehrt.
          if ((route.kind === 'mcp' || route.kind === 'function') && route.sideEffect === 'write') invalidateIndex();
          trace.push({ ts: Date.now(), step: 'tool.call', detail: { tool: call.function.name, args } });
        } catch (e) {
          result = `ERROR: ${String(e)}`;
          trace.push({
            ts: Date.now(),
            step: 'tool.error',
            detail: { tool: call.function.name, error: String(e) },
          });
        }
        return { id: call.id, content: result };
      })
    );
    for (const r of results) {
      messages.push({ role: 'tool', content: r.content, tool_call_id: r.id });
    }
  };
  const maxIter = getSettingNum('max_tool_iterations', config.maxToolIterations);
  for (let i = 0; i < maxIter; i++) {
    if (i > 0 && Date.now() >= overallDeadline) {
      trace.push({ ts: Date.now(), step: 'tool.deadline' });
      return { speech: TimeoutAnswer };
    }
    // Letzte Runde: Formulierung erzwingen (sonst kaufte das Modell das Budget
    // voll und die Schleife endete ohne Antwort).
    if (i === maxIter - 1) {
      messages.push({
        role: 'system',
        content: 'Letzte Runde: formuliere JETZT die finale Antwort aus den bisherigen Tool-Ergebnissen - keine weiteren Tool-Aufrufe.',
      });
    }
    const remaining = Math.min(toolDeadline(), Math.max(overallDeadline - Date.now(), 5000));
    let message: ChatMessage;
    try {
      const result = await chatCompletion(messages, specs.length > 0 ? specs : undefined, remaining, roundModel);
      message = result.message;
      traceUsage(trace, roundModel ?? config.llm.model, result);
    } catch (e) {
      if (!(String(e).includes('TimeoutError') || String(e).includes('abort'))) throw e;
      trace.push({ ts: Date.now(), step: 'llm.timeout', detail: { round: i } });
      if (i === 0) {
        try {
          const retryResult = await chatCompletion(messages, specs.length > 0 ? specs : undefined, 7000, roundModel);
          traceUsage(trace, roundModel ?? config.llm.model, retryResult);
          const retry = retryResult.message;
          if (!retry.tool_calls || retry.tool_calls.length === 0) {
            return parseAgentAnswer(retry.content ?? '', trace);
          }
          await runTools(retry);
          const finalResult = await chatCompletion(messages, undefined, 7000, roundModel);
          traceUsage(trace, roundModel ?? config.llm.model, finalResult);
          const final = finalResult.message;
          return parseAgentAnswer(final.content ?? '', trace);
        } catch (e2) {
          trace.push({ ts: Date.now(), step: 'tool.deadline', detail: String(e2).slice(0, 60) });
          return { speech: TimeoutAnswer };
        }
      }
      trace.push({ ts: Date.now(), step: 'tool.deadline' });
      return { speech: TimeoutAnswer };
    }
    if (!message.tool_calls || message.tool_calls.length === 0) {
      return parseAgentAnswer(message.content ?? '', trace);
    }
    await runTools(message);
  }
  return { speech: TimeoutAnswer };
}

async function runAgent(query: VoiceQuery, mcp: McpContext, trace: TraceEvent[]): Promise<AssistantResponse> {
  // Allowlist-Semantik (mit der Vorgangs-Checkbox-Logik konsistent):
  // nicht gesetzt oder "alle" = alle Tools; "keine" = keine Specs;
  // Komma-Liste = genau diese. (Leere Auswahl in der UI wird als "keine"
  // gespeichert - KEIN stiller "leer = alle"-Fall mehr.)
  const agentToolsRaw = (getSetting('agent_tools') ?? '').trim().toLowerCase();
  let allowlist: string[] | null;
  if (!agentToolsRaw || agentToolsRaw === 'alle') allowlist = null;
  else if (agentToolsRaw === 'keine') allowlist = [];
  else allowlist = agentToolsRaw.split(',').map((s) => s.trim()).filter(Boolean);
  const system = agentSystemPrompt(mcp, allowlist);
  const response = await runToolLoop(system, query.text, mcp, trace, query.sessionId, allowlist);
  rememberTurn(query.sessionId, query.text, response.speech);
  return response;
}

async function executeAction(
  action: ParsedAction,
  query: VoiceQuery,
  mcp: McpContext,
  trace: TraceEvent[]
): Promise<AssistantResponse> {
  // Die geseedete Hilfe bekommt den VOLLSTAENDIGEN Faehigkeiten-Katalog (jede
  // aktive Funktion mit Beschreibung/Parametern, jeder Server) statt des ueber
  // agent_tools gefilterten Inventars - so nennt das LLM zuverlaessig alle Tools
  // und deren Nutzung in einfacher Sprache. Kein MCP, keine Tool-Aufrufe.
  if (isSeededHelp(action)) {
    const catalog = renderHelpCatalog();
    if (!catalog) {
      trace.push({ ts: Date.now(), step: 'help.empty', detail: { action: action.name } });
      return { speech: renderHelpFallback(), followUp: true, followupPrompt: 'Was interessiert dich?' };
    }
    const system = (action.system_prompt?.replaceAll('{assistant_name}', assistantName()) ?? '').replace(
      '{agent_inventory}',
      catalog
    );
    trace.push({ ts: Date.now(), step: 'help.catalog', detail: { action: action.name } });
    try {
      const history = query.sessionId ? priorTurns(query.sessionId) : [];
      const result = await chatCompletion(
        [{ role: 'system', content: system }, ...history, { role: 'user', content: query.text }],
        undefined,
        undefined,
        undefined,
        HELP_MAX_TOKENS
      );
      traceUsage(trace, config.llm.model, result);
      const parsed = parseAgentAnswer(result.message.content ?? '', trace);
      if (parsed.speech?.trim()) return { ...parsed, followUp: true, followupPrompt: 'Was interessiert dich?' };
      trace.push({ ts: Date.now(), step: 'help.empty_answer' });
    } catch (e) {
      trace.push({ ts: Date.now(), step: 'help.error', detail: String(e) });
    }
    return { speech: renderHelpFallback(), followUp: true, followupPrompt: 'Was interessiert dich?' };
  }
  if (action.mode === 'llm') {
    // Das Inventory wird nur in Prompts eingefuegt, die den Marker tragen. Ein
    // solcher Vorgang OHNE eigene Tools (Hilfe) beschreibt ALLE eingerichteten
    // Systeme; ein Vorgang mit Tool-Liste bleibt darauf gescopt (F-D1).
    const showsCatalog = action.system_prompt?.includes('{agent_inventory}') ?? false;
    const noTools = !action.toolList || action.toolList.length === 0;
    const inventoryScope = showsCatalog && noTools ? null : activeServerNames(mcp, action.toolList);
    const system = (action.system_prompt?.replaceAll('{assistant_name}', assistantName()) ?? agentSystemPrompt(mcp, action.toolList))
      .replace('{agent_inventory}', buildInventoryPrompt(inventoryScope));
    return runToolLoop(system, query.text, mcp, trace, query.sessionId, action.toolList);
  }
  // deterministic/hybrid: Daten kommen ausschliesslich aus einer Funktion
  if (!action.function_ref) {
    trace.push({ ts: Date.now(), step: 'action.error', detail: { action: action.name, reason: 'keine Funktion zugewiesen' } });
    return { speech: 'Dieser Vorgang ist nicht richtig eingerichtet: Es ist keine Funktion zugewiesen.' };
  }
  const rendered = await renderFunction(action.function_ref, mcp, trace, action.functionArgs ?? {});
  // Auch ein direkter Funktionsaufruf (deterministic/hybrid) kann via mcp.call
  // den Index-Zustand veraendern - schreibende Funktionen verwerfen den Cache.
  if (getFunctionByName(action.function_ref)?.side_effect === 'write') invalidateIndex();
  if (action.mode === 'deterministic') return rendered;
  const system = action.system_prompt?.replaceAll('{assistant_name}', assistantName()) ?? agentSystemPrompt(mcp, action.toolList);
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    {
      role: 'user',
      content: `Daten:\n${rendered.speech}\n\nAnfrage: ${query.text}\nFormuliere daraus eine kurze, sprechbare Antwort.`,
    },
  ];
  const result = await chatCompletion(messages);
  return parseAgentAnswer(result.message.content ?? '', trace);
}

// Die geseedete Hilfe (Name 'hilfe' + Referenz-Marker "Hilfe-Anfrage") wird
// deterministisch beantwortet; eigene Hilfe-Texte bleiben beim LLM.
function isSeededHelp(action: ParsedAction): boolean {
  return action.name === 'hilfe' && (action.system_prompt?.includes('Hilfe-Anfrage') ?? false);
}

// MCP-Kontext nur laden, wenn der Weg ihn tatsaechlich braucht: der Agent und
// LLM-Vorgaenge immer, deterministische/hybride Vorgaenge nur, wenn ihre
// Funktion MCP/index/fn nutzt (reine http-/shell-Funktionen sparen den
// Kaltstart; F-11). Die deterministische Hilfe braucht kein MCP.
function actionNeedsMcp(action: ParsedAction): boolean {
  if (isSeededHelp(action)) return false;
  if (action.mode === 'llm') return true;
  const fn = action.function_ref ? getFunctionByName(action.function_ref) : null;
  const lit = extractLiterals(fn?.template ?? '');
  return lit.calls.length > 0 || lit.mcpCallDyn.length > 0 || lit.usesIndex || lit.fns.length > 0;
}

const CHAT_ON_RE = /(chat[-\s]?modus|chatmodus|unterhaltung[-\s]?modus|gespraechs?[-\s]?modus|im gespraech bleiben)/i;
const CHAT_OFF_RE = /(one[-\s]?shot|einzelmodus|alltag[-\s]?modus|beende.*chat|chat[-\s]?beenden|wechsle.*one[-\s]?shot)/i;

export function isChatSession(sessionId: string): boolean {
  return sessionIsChat(sessionId);
}

export async function processQuery(query: VoiceQuery): Promise<EngineResult> {
  const start = Date.now();
  const trace: TraceEvent[] = [
    { ts: start, step: 'query', detail: { sessionId: query.sessionId, text: query.text } },
  ];

  // Chat-/OneShot-Modus-Wechsel: deterministisch, Session-Zustand
  const qLower = query.text.toLowerCase();
  if (CHAT_OFF_RE.test(qLower)) {
    setChatMode(query.sessionId, false);
    trace.push({ ts: Date.now(), step: 'chat.off', detail: { sessionId: query.sessionId } });
    return {
      response: { speech: 'Okay, ich beantworte die nächsten Fragen wieder einzeln.', followUp: false },
      route: 'chat',
      durationMs: Date.now() - start,
      trace,
    };
  }
  if (CHAT_ON_RE.test(qLower)) {
    setChatMode(query.sessionId, true);
    trace.push({ ts: Date.now(), step: 'chat.on', detail: { sessionId: query.sessionId } });
    return {
      response: {
        speech: 'Gut, ich bleibe im Gespräch. Was möchtest du noch wissen?',
        followUp: true,
        followupPrompt: 'Was möchtest du noch wissen?',
      },
      route: 'chat',
      durationMs: Date.now() - start,
      trace,
    };
  }
  const actions = listActions(true);
  const fuzzyGlobal = getSetting('fuzzy_global') !== '0';
  const match: RouteMatch | null = routeAction(query.text, actions, fuzzyGlobal);
  const needsMcp = !match || actionNeedsMcp(match.action);
  const mcp = needsMcp
    ? await getMcpContext().catch((e: unknown) => {
        trace.push({ ts: Date.now(), step: 'mcp.error', detail: String(e) });
        return { servers: [] } as McpContext;
      })
    : ({ servers: [] } as McpContext);

  let response: AssistantResponse;
  let route: string;
  if (match) {
    route = 'action';
    trace.push({
      ts: Date.now(),
      step: 'route.action',
      detail: { action: match.action.name, score: match.score, phrase: match.phrase },
    });
    try {
      response = await executeAction(match.action, query, mcp, trace);
      rememberTurn(query.sessionId, query.text, response.speech);
    } catch (e) {
      trace.push({ ts: Date.now(), step: 'action.error', detail: String(e) });
      response = { speech: FallbackError };
    }
  } else {
    route = 'agent';
    trace.push({ ts: Date.now(), step: 'route.agent' });
    try {
      response = await runAgent(query, mcp, trace);
    } catch (e) {
      trace.push({ ts: Date.now(), step: 'agent.error', detail: String(e) });
      response = { speech: FallbackError };
    }
  }

  response = withSsmlBreaks(response);
  response = withDisplay(response);

  if (sessionIsChat(query.sessionId)) {
    response = { ...response, followUp: true, followupPrompt: 'Was möchtest du noch wissen?' };
  } else if (!response.followUp) {
    const mode = getSetting('session_followup') ?? '0';
    const wantLlm = mode === 'llm' || mode === 'beides';
    const wantKw = mode === 'keyword' || mode === 'beides';
    const kwList = (getSetting('session_keywords') ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const kwHit = wantKw && kwList.some((k) => query.text.toLowerCase().includes(k));
    const llmHit = wantLlm && response.keepOpen === true;
    if (kwHit || llmHit) {
      response = { ...response, followUp: true, followupPrompt: 'Was kann ich noch für Sie tun?' };
    }
  }

  const durationMs = Date.now() - start;
  addLog({
    sessionId: query.sessionId,
    query: query.text,
    route,
    actionId: match?.action.id,
    score: match?.score,
    response: response.speech,
    durationMs,
    trace,
    ...sumUsageFromTrace(trace),
  });
  return {
    response,
    route,
    actionId: match?.action.id,
    score: match?.score,
    durationMs,
    trace,
  };
}
