// Audit-Proben (Voll-Audit 2026-09-27): je Probe ein Befund. F-01..F-09 sind
// behoben und echte Regressionstests; die F-10-Probe sichern wir als
// dokumentierte Entscheidung ab (Single-User, Cross-Session-Recall gewollt).
// Keine echten Netze/Dienste - fetch/DB werden isoliert.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Env VOR dem (dynamischen) Import der config-abhaengigen Module setzen:
// dotenv ueberschreibt bereits gesetzte Werte nicht.
process.env.AUTH_TOKEN = 'audit-test-token';
process.env.LLM_BASE_URL = 'http://127.0.0.1:9';
process.env.LLM_API_KEY = 'audit-test-key';
process.env.LLM_MODEL = 'audit-test-model';
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'audit-db-')), 'audit.sqlite');

const { extractLiterals } = await import('../src/core/extract.js');
const { routeAction } = await import('../src/core/router.js');
const { normalizeActionInput } = await import('../src/core/normalize.js');
const { cookieFor } = await import('../src/auth.js');
const { stripSsmlTags } = await import('../src/core/response.js');
const { isPrivateHost } = await import('../src/core/template.js');
const { chatCompletion } = await import('../src/llm/client.js');
const { createMcpServer, listMcpServers } = await import('../src/db/mcpServers.js');
const { addLog, recentAgentTurns } = await import('../src/db/logs.js');

const originalFetch = globalThis.fetch;
let lastInit: RequestInit | undefined;

function capturedInit(): RequestInit | undefined {
  return lastInit;
}

// ---- F-01: Preheat ignoriert Kontrollfluss/Kommentare nicht ----
// extractLiterals zaehlt datenholende Aufrufe auch dann, wenn sie in einem
// nicht ausgefuehrten if-Zweig oder in einem nunjucks-Kommentar stehen. Der
// Preheat in template.ts fuehrt sie folglich trotzdem aus.
test('extractLiterals: shell() in nunjucks-Kommentar wird nicht extrahiert', () => {
  const found = extractLiterals("Hallo {# {{ shell('rm -rf /tmp/x') }} #}");
  assert.deepEqual(found.shells, []);
});

// ---- F-02: extract.ts ohne Wortgrenzen ----
// `xfn('a')`, `myshell('x')`, `myhttp(...)` werden als fn()/shell()/http()
// fehlinterpretiert, weil die Regexe keine Wortgrenze pruefen.
test('extractLiterals: kein Fehltreffer bei xfn/myshell/myhttp', () => {
  const found = extractLiterals("{{ xfn('a') }} {{ myshell('id') }} {{ myhttp('http://x') }}");
  assert.deepEqual(found.fns, []);
  assert.deepEqual(found.shells, []);
  assert.deepEqual(found.httpCalls, []);
});

// ---- F-03: fuzzy_threshold ausserhalb 0..1 ----
// Ein negativer Schwellwert laesst score=0 >= threshold werden -> die Action
// matcht JEDE Anfrage (Hijack). normalizeActionInput klemmt den Wert nicht.
test('routeAction: negativer fuzzy_threshold darf nicht alles treffen', () => {
  const action = {
    id: 1,
    name: 'hijack',
    mode: 'llm' as const,
    trigger_phrases: null,
    fuzzy_threshold: -0.5,
    system_prompt: null,
    template: null,
    function_ref: null,
    function_args: null,
    tools: null,
    enabled: 1,
    triggers: ['hausstatus'],
    toolList: [],
    functionArgs: null,
  };
  const m = routeAction('voellig themenfremde frage', [action], false);
  assert.equal(m, null);
});

// ---- F-04: enabled 0/1 aus dem GET-Roundtrip ----
// GET liefert enabled als Zahl (0/1). normalizeActionInput wertet nur
// `enabled === false` als "aus" -> eine 0 aus dem Roundtrip wird zu 1.
test('normalizeActionInput: enabled=0 (GET-Roundtrip) bleibt 0', () => {
  const input = normalizeActionInput({ name: 'a', mode: 'llm', enabled: 0 });
  assert.equal(input.enabled, 0);
});

// ---- F-05: Session-Cookie ohne Secure-Flag ----
test('cookieFor: Session-Cookie traegt das Secure-Flag', () => {
  assert.match(cookieFor('abc'), /(?:^|;)\s*Secure(?:;|$)/);
});

// ---- F-06: stripSsmlTags dekodiert keine XML-Entities ----
test('stripSsmlTags: XML-Entities werden dekodiert', () => {
  assert.equal(stripSsmlTags('<speak>Milch &amp; Honig</speak>'), 'Milch & Honig');
});

// ---- F-07: isPrivateHost umgehbar ----
// Dezimal-, Hex- und vollstaendige IPv6-Schreibweisen privater Adressen
// passieren den Filter; fetch loest sie anschliessend auf. Positive Kontrolle
// stellt sicher, dass der Filter grundsaetzlich greift.
test('isPrivateHost: bekannte Kurzform 127.0.0.1 ist privat', () => {
  assert.equal(isPrivateHost('127.0.0.1'), true);
});

test('isPrivateHost: Dezimal-/Hex-/IPv6-Form privater Netze wird erkannt', () => {
  assert.equal(isPrivateHost('2130706433'), true); // 127.0.0.1 als Dezimalzahl
  assert.equal(isPrivateHost('0x7f000001'), true);
  assert.equal(isPrivateHost('::ffff:7f00:1'), true);
});

// ---- F-08: LLM-Aufruf ohne Default-Timeout ----
// chatCompletion setzt nur dann ein Abort-Signal, wenn timeoutMs uebergeben
// wird. Der Hybrid-Pfad (engine.ts) ruft chatCompletion(messages) ohne
// Timeout -> ein haengender LLM-Server blockiert unbegrenzt.
test('chatCompletion: ohne expliziten Timeout greift ein Default-Signal', async () => {
  lastInit = undefined;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    lastInit = init;
    return {
      ok: true,
      status: 200,
      text: async () => '{}',
      json: async () => ({ model: 'm', choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
    } as unknown as Response;
  }) as typeof fetch;
  await chatCompletion([{ role: 'user', content: 'frage' }]);
  assert.ok(capturedInit()?.signal, 'erwartet ein AbortSignal als Default-Timeout');
});

// ---- F-09: MCP-Server-Endpunkt liefert Geheimnisse im Klartext ----
// listMcpServers(false) liefert auth_token (und env) ungefiltert an die
// Admin-API; ein Token ist damit im Browser/Netz sichtbar.
test('listMcpServers: auth_token wird nicht im Klartext geliefert', () => {
  createMcpServer({
    name: 'audit-srv',
    url: 'http://127.0.0.1:9/mcp',
    auth_token: 'streng-geheim',
    transport: 'http',
    command: null,
    args: null,
    env: null,
    inventory_prompt: null,
    enabled: 1,
  });
  const row = listMcpServers(false).find((s) => s.name === 'audit-srv');
  assert.equal(row?.auth_token ?? null, null);
});

// ---- F-10: bewusste Entscheidung, kein Defekt ----
// Der DB-Recall ist absichtlich session-uebergreifend (Single-User-Instanz,
// siehe doc/ARCHITECTURE.md). Diese Probe sichert das gewollte Verhalten ab.
test('recentAgentTurns: Cross-Session-Recall (bewusste Single-User-Entscheidung)', () => {
  addLog({
    sessionId: 'audit-andere-session',
    query: 'frage aus anderer session',
    route: 'agent',
    response: 'antwort aus anderer session',
    durationMs: 5,
    trace: [],
  });
  const turns = recentAgentTurns(1, 3_600_000);
  assert.ok(turns.some((t) => t.query === 'frage aus anderer session'));
});

after(() => {
  globalThis.fetch = originalFetch;
});
