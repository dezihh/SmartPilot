import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { processQuery, isChatSession } from '../src/core/engine.js';
import { initDb, closeDb, getDb } from '../src/db/schema.js';
import { createFunction } from '../src/db/functions.js';
import { createAction } from '../src/db/actions.js';
import { setSetting, deleteSetting } from '../src/db/settings.js';
import { resetSessionsForTests } from '../src/core/session.js';
import { indexInvalidationsForTests } from '../src/core/entityIndex.js';
import type { TraceEvent } from '../src/types.js';
import { tmpDb } from './_tmpdb.js';

const DB_PATH = tmpDb('engine');

const originalFetch = globalThis.fetch;
let llmCalls = 0;
let llmScript: unknown[] = [];
let llmBodies: { messages: { role: string; content: string | null }[] }[] = [];

function stubFetchEngine(): void {
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    if (!String(url).includes('chat/completions')) {
      return { ok: false, status: 404, text: async () => '', json: async () => ({}) } as unknown as Response;
    }
    llmBodies.push(JSON.parse(String(init?.body ?? '{}')));
    const i = llmCalls++;
    const data = llmScript[i] ?? { choices: [{ message: { role: 'assistant', content: 'leer' } }] };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(data),
      json: async () => data,
    } as unknown as Response;
  }) as typeof fetch;
}

function content(txt: string): unknown {
  return { choices: [{ message: { role: 'assistant', content: txt } }], usage: { prompt_tokens: 3, completion_tokens: 2 } };
}

function toolCalls(calls: { name: string; args: string }[]): unknown {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: calls.map((c, idx) => ({
            id: `call_${idx}`,
            type: 'function',
            function: { name: c.name, arguments: c.args },
          })),
        },
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 1 },
  };
}

async function q(text: string, sessionId: string): Promise<Awaited<ReturnType<typeof processQuery>>> {
  return processQuery({ text, sessionId });
}

function findStep(trace: TraceEvent[], step: string): TraceEvent | undefined {
  return trace.find((t) => t.step === step);
}

before(() => {
  closeDb();
  initDb(DB_PATH);
  resetSessionsForTests();
  const db = getDb();
  db.exec('DELETE FROM actions; DELETE FROM tpl_functions; DELETE FROM logs; DELETE FROM settings;');
  createFunction({
    name: 'test_echo',
    description: 'Echo-Testfunktion',
    template: 'Echo: {{ args.x }}',
    parameters: '{"type":"object","properties":{"x":{"type":"string"}}}',
    budget: null,
    inventory_prompt: null,
    enabled: 1,
  });
  createFunction({
    name: 'test_fn_det',
    description: null,
    template: 'Deterministisch: {{ args.wert }}',
    parameters: null,
    budget: null,
    inventory_prompt: null,
    enabled: 1,
  });
});

beforeEach(() => {
  llmCalls = 0;
  llmScript = [];
  llmBodies = [];
  stubFetchEngine();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

after(() => {
  globalThis.fetch = originalFetch;
  closeDb();
  initDb(DB_PATH);
  getDb().exec(
    "DELETE FROM actions WHERE name LIKE 'test%'; DELETE FROM tpl_functions WHERE name LIKE 'test%'; DELETE FROM logs; DELETE FROM settings;"
  );
  closeDb();
});

test('Chat-Modus an: deterministischer Schalter, Session offen', async () => {
  const r = await q('chat-modus an', 'chat-on');
  assert.equal(r.route, 'chat');
  assert.equal(r.response.followUp, true);
  assert.equal(isChatSession('chat-on'), true);
});

test('Chat-Modus aus: Session wird geschlossen', async () => {
  await q('chat-modus an', 'chat-off');
  const r = await q('beende chat', 'chat-off');
  assert.equal(r.route, 'chat');
  assert.equal(r.response.followUp, false);
  assert.equal(isChatSession('chat-off'), false);
  assert.equal(llmCalls, 0, 'Modus-Wechsel ohne LLM-Aufruf');
});

test('offene Frage -> Agent-Route mit LLM-Antwort', async () => {
  llmScript = [content('Hier ist die Antwort.')];
  const r = await q('erzaehl mir etwas ueber bayern', 'agent1');
  assert.equal(r.route, 'agent');
  assert.match(r.response.speech, /Antwort/);
  assert.ok(findStep(r.trace, 'route.agent'));
  assert.ok(findStep(r.trace, 'llm.usage'));
});

test('Agent-Tool-Loop: fn-Tool wird aufgerufen, dann formuliert', async () => {
  llmScript = [
    toolCalls([{ name: 'fn_test_echo', args: '{"x":"wert1"}' }]),
    content('fertig mit wert1'),
  ];
  const r = await q('nutze das echo tool mit wert1', 'loop1');
  assert.equal(r.route, 'agent');
  assert.match(r.response.speech, /fertig mit wert1/);
  const toolCall = findStep(r.trace, 'tool.call');
  assert.ok(toolCall);
  assert.deepEqual((toolCall.detail as { args: Record<string, string> }).args, { x: 'wert1' });
});

test('Tool-Budget-Hit: zweiter Aufruf wird blockiert, Schleife endet sauber', async () => {
  getDb().prepare("UPDATE tpl_functions SET budget = 1 WHERE name = 'test_echo'").run();
  setSetting('max_tool_iterations', '4');
  try {
    llmScript = Array.from({ length: 4 }, () =>
      toolCalls([{ name: 'fn_test_echo', args: '{"x":"mehrfach"}' }])
    );
    const r = await q('spame das echo tool', 'budget1');
    assert.ok(findStep(r.trace, 'tool.budget_hit'), 'budget_hit Trace fehlt');
    assert.match(r.response.speech, /zu lange gedauert/);
    assert.equal(llmCalls, 4, 'Schleife endet nach max_iter');
  } finally {
    getDb().prepare("UPDATE tpl_functions SET budget = NULL WHERE name = 'test_echo'").run();
    deleteSetting('max_tool_iterations');
  }
});

test('deterministische Action mit function_ref + function_args', async () => {
  createAction({
    name: 'test_det',
    mode: 'deterministic',
    trigger_phrases: '["hausstatus-test"]',
    fuzzy_threshold: 0.85,
    system_prompt: null,
    template: null,
    function_ref: 'test_fn_det',
    function_args: '{"wert":"42"}',
    tools: '[]',
    enabled: 1,
  });
  const r = await q('hausstatus-test', 'det1');
  assert.equal(r.route, 'action');
  assert.match(r.response.speech, /Deterministisch: 42/);
  assert.ok(r.actionId);
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) AS n FROM logs WHERE route = ?').get('action') as { n: number };
  assert.ok(row.n > 0, 'Log geschrieben');
});

test('deterministische Action ohne function_ref -> klarer Hinweis', async () => {
  createAction({
    name: 'test_det_leer',
    mode: 'deterministic',
    trigger_phrases: '["ohne-fn-test"]',
    fuzzy_threshold: 0.85,
    system_prompt: null,
    template: null,
    function_ref: null,
    function_args: null,
    tools: '[]',
    enabled: 1,
  });
  const r = await q('ohne-fn-test', 'det2');
  assert.match(r.response.speech, /keine Funktion zugewiesen/);
  assert.ok(findStep(r.trace, 'action.error'));
});

test('hybrid-Action: Funktion liefert Daten, LLM formuliert', async () => {
  createAction({
    name: 'test_hybrid',
    mode: 'hybrid',
    trigger_phrases: '["hybrid-test"]',
    fuzzy_threshold: 0.85,
    system_prompt: 'Formuliere kurz: {assistant_name}',
    template: null,
    function_ref: 'test_fn_det',
    function_args: '{"wert":"Datenbasis"}',
    tools: '[]',
    enabled: 1,
  });
  setSetting('assistant_name', 'Dein Helfer');
  llmScript = [content('Kurzfassung der Datenbasis.')];
  const r = await q('hybrid-test', 'hyb1');
  assert.equal(r.route, 'action');
  assert.match(r.response.speech, /Kurzfassung/);
  deleteSetting('assistant_name');
});

test('llm-Action ohne Tools: System-Prompt + Agent-Antwort', async () => {
  createAction({
    name: 'test_llm_action',
    mode: 'llm',
    trigger_phrases: '["frage-llm-test"]',
    fuzzy_threshold: 0.85,
    system_prompt: 'Antworte als {assistant_name}.',
    template: null,
    function_ref: null,
    function_args: null,
    tools: '[]',
    enabled: 1,
  });
  llmScript = [content('Antwort als Hilfskraft.')];
  const r = await q('frage-llm-test', 'llmact1');
  assert.equal(r.route, 'action');
  assert.match(r.response.speech, /Antwort als/);
});

test('session_followup keyword: Treffer haelt Session offen, ohne Treffer schliesst', async () => {
  setSetting('session_followup', 'keyword');
  setSetting('session_keywords', 'temperatur');
  try {
    llmScript = [content('warm, 21 Grad.')];
    const r1 = await q('wie ist die temperatur im wohnzimmer', 'kw1');
    assert.equal(r1.response.followUp, true);
    assert.ok(r1.response.followupPrompt);
    llmScript = [content('Alles zu.')];
    const r2 = await q('was ist heute fuer ein tag', 'kw2');
    assert.ok(!r2.response.followUp, 'kein Followup ohne Keyword-Treffer');
  } finally {
    deleteSetting('session_followup');
    deleteSetting('session_keywords');
  }
});

test('session_followup llm: keep_open im JSON haelt Session offen', async () => {
  setSetting('session_followup', 'llm');
  try {
    llmScript = [content('{"speech":"Kurzinfo zur Anfrage.","keep_open":true}')];
    const r = await q('noch eine offene frage ueber irgendwas', 'kp1');
    assert.equal(r.response.followUp, true);
  } finally {
    deleteSetting('session_followup');
  }
});

test('Chat-Session haelt JEDE Antwort offen (Modus schlaegt Keyword)', async () => {
  await q('chat-modus an', 'chat-sticky');
  llmScript = [content('Irgendeine Antwort.')];
  const r = await q('beliebige frage jetzt', 'chat-sticky');
  assert.equal(r.response.followUp, true);
  assert.equal(isChatSession('chat-sticky'), true);
});

function userMessages(body: { messages: { role: string; content: string | null }[] }): string[] {
  return body.messages.filter((m) => m.role === 'user').map((m) => m.content ?? '');
}

test('memory_turns: Kontext-Tiefe konfigurierbar (Default 4)', async () => {
  setSetting('memory_turns', '1');
  try {
    llmScript = [content('antwort eins'), content('antwort zwei'), content('antwort drei')];
    await q('erste frage', 'mem1');
    await q('zweite frage', 'mem1');
    await q('dritte frage', 'mem1');
    // 3. LLM-Call: system + letzte Pair (1 Turn) + aktuelle Frage
    const third = llmBodies[2];
    const users = userMessages(third);
    assert.deepEqual(users, ['zweite frage', 'dritte frage']);
  } finally {
    deleteSetting('memory_turns');
  }
});

test('memory_turns: mit Default sieht der 3. Aufruf beide frueheren Pairs', async () => {
  llmScript = [content('antwort eins'), content('antwort zwei'), content('antwort drei')];
  await q('erste frage', 'mem2');
  await q('zweite frage', 'mem2');
  await q('dritte frage', 'mem2');
  const users = userMessages(llmBodies[2]);
  assert.deepEqual(users, ['erste frage', 'zweite frage', 'dritte frage']);
});

test('memory_minutes: DB-Recall ueber Session-Grenzen mit Zeitfenster', async () => {
  const db = getDb();
  db.exec("DELETE FROM logs WHERE route = 'agent'");
  try {
    setSetting('memory_turns', '2');
    setSetting('memory_minutes', '30');
    // Frisch (< 5 min): Recall OHNE ALT-Hinweis, Pairs kommen direkt
    db.prepare(
      "INSERT INTO logs (session_id, query, route, response, ts) VALUES ('alt', 'alte frage frisch', 'agent', 'frische Antwort', datetime('now', '-2 minutes'))"
    ).run();
    resetSessionsForTests(); // In-Memory leer -> DB-Recall greift
    llmScript = [content('neue antwort')];
    await q('neue frage', 'mem-recall');
    let msgs = llmBodies[0].messages;
    assert.ok(!msgs.some((m) => m.role === 'system' && (m.content ?? '').includes('fruehere Unterhaltungen')), 'frischer Turn ohne ALT-Hinweis');
    assert.ok(msgs.some((m) => m.role === 'user' && m.content === 'alte frage frisch'), 'frischer Turn im Recall');
    assert.ok(msgs.some((m) => m.role === 'assistant' && m.content === 'frische Antwort'), 'frische Antwort im Recall');
    // Aelter als 5 min (aber im Fenster): ALT-Hinweis kommt dazu
    db.exec("DELETE FROM logs WHERE route = 'agent'");
    db.prepare(
      "INSERT INTO logs (session_id, query, route, response, ts) VALUES ('alt', 'alte frage alt', 'agent', 'alte Antwort', datetime('now', '-6 minutes'))"
    ).run();
    db.prepare(
      "INSERT INTO logs (session_id, query, route, response, ts) VALUES ('alt', 'alte frage uralt', 'agent', 'urale Antwort', datetime('now', '-35 minutes'))"
    ).run();
    resetSessionsForTests();
    llmBodies = [];
    llmScript = [content('neue antwort 2')];
    await q('neue frage zwei', 'mem-recall-2');
    msgs = llmBodies[0].messages;
    assert.ok(msgs.some((m) => m.role === 'system' && (m.content ?? '').includes('fruehere Unterhaltungen')), 'ALT-Hinweis bei >5min fehlt');
    assert.ok(msgs.some((m) => m.role === 'user' && m.content === 'alte frage alt'), 'Turn im Fenster (6 min) drin');
    assert.ok(!msgs.some((m) => (m.content ?? '').includes('alte frage uralt')), 'Turn ausserhalb des Fensters (35 min) raus');
  } finally {
    deleteSetting('memory_turns');
    deleteSetting('memory_minutes');
    db.exec("DELETE FROM logs WHERE route = 'agent'");
  }
});

test('Index-Cache: nach Funktions-/MCP-Call invalidiert, nach Basis-Lesetool nicht', async () => {
  const vorher = indexInvalidationsForTests();
  // Funktion (kind 'function') kann den Zustand aendern -> Cache verwerfen.
  llmScript = [toolCalls([{ name: 'fn_test_echo', args: '{"x":"a"}' }]), content('ok')];
  await q('echo bitte', 'inv-fn');
  assert.ok(indexInvalidationsForTests() > vorher, 'nach Funktions-Call invalidiert');

  const nachFn = indexInvalidationsForTests();
  // Basis-Lesetool (kind 'index_find') hat gerade gelesen -> nicht invalidieren.
  llmScript = [toolCalls([{ name: 'fn_find_entities', args: '{"query":"x"}' }]), content('ok')];
  await q('suche x', 'inv-index');
  assert.equal(indexInvalidationsForTests(), nachFn, 'Basis-Lesetool invalidiert nicht');

  // Explizit lesende Funktion (side_effect 'read') verwirft den Cache nicht.
  getDb().prepare("UPDATE tpl_functions SET side_effect = 'read' WHERE name = 'test_echo'").run();
  try {
    const nachRead = indexInvalidationsForTests();
    llmScript = [toolCalls([{ name: 'fn_test_echo', args: '{"x":"a"}' }]), content('ok')];
    await q('echo lesend', 'inv-read');
    assert.equal(indexInvalidationsForTests(), nachRead, 'read-Funktion invalidiert nicht');
  } finally {
    getDb().prepare("UPDATE tpl_functions SET side_effect = 'write' WHERE name = 'test_echo'").run();
  }
});
