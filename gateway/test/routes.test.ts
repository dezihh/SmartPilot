// Route-Tests fuer die Express-App (Empfehlung 4). Baut die App ueber
// createApp() ohne listen und spricht sie ueber node:http an, damit
// globalThis.fetch fuer MCP-Stubs frei bleibt.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { request, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

// config/auth lesen die Umgebung beim Import -> vor den dynamischen Importen setzen.
process.env.ADMIN_TOKEN = 'test-secret';
process.env.API_TOKEN = 'test-query-secret';
process.env.QUERY_RATE_MAX = '2'; // kleiner Wert fuer den Rate-Limit-Test
process.env.LLM_BASE_URL = 'http://127.0.0.1:9/v1';
process.env.LLM_API_KEY = 'test-key';
process.env.LLM_MODEL = 'test-model';

const { tmpDb } = await import('./_tmpdb.js');
const { initDb, closeDb, getDb } = await import('../src/db/schema.js');
const { createApp } = await import('../src/app.js');
const { resetRateLimitsForTests } = await import('../src/rateLimit.js');
const { createMcpServer } = await import('../src/db/mcpServers.js');
const { getSetting, deleteSetting, setSetting } = await import('../src/db/settings.js');
const { invalidateMcpCache } = await import('../src/mcp/registry.js');

closeDb(); // hermetisch: Container-DB durch Temp-DB ersetzen
initDb(tmpDb('routes'));

const app = createApp();
const server = app.listen(0);
await new Promise<void>((resolve) => server.once('listening', () => resolve()));
const PORT = (server.address() as AddressInfo).port;

after(() => {
  server.close();
  closeDb();
});

interface RouteRes {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
  json: unknown;
}

function call(
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string; token?: string; accept?: string } = {}
): Promise<RouteRes> {
  return new Promise((resolve, reject) => {
    const data = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers: Record<string, string> = {};
    if (data) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(data));
    }
    if (opts.cookie) headers.cookie = opts.cookie;
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.accept) headers.accept = opts.accept;
    const req = request({ host: '127.0.0.1', port: PORT, method, path, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => {
        let json: unknown = null;
        try {
          json = JSON.parse(body) as unknown;
        } catch {
          /* kein JSON */
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text: body, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

let cookie = '';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonRes(obj: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
    headers: { get: () => null },
  } as unknown as Response;
}

const PKG_MANIFEST = {
  id: 'test-package',
  version: '1.0.0',
  name: 'Test-Paket',
  summary: 'Kurz',
  description: 'Lang',
  params: [{ key: 'host', label: 'Host', default: '127.0.0.1', required: true }],
  servers: [{ name: 'Test MCP', transport: 'http', url: 'http://${host}:8086/mcp' }],
  functions: [{ name: 'test_fn', template: 'Server ${host}.', parameters: { type: 'object', properties: {} }, budget: 1 }],
  indexes: [{ key: '', config: { tool: 'x_tool', args: {} } }],
  allowTools: ['x_tool', 'fn_test_fn'],
};

// Registry-Fetches (GitHub) stubben: index.json + manifest.json.
function stubRegistry(): void {
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    if (u.endsWith('/index.json')) {
      return jsonRes({ registryVersion: 1, packages: [{ id: 'test-package', name: 'Test-Paket', summary: 'Kurz', version: '1.0.0' }] });
    }
    if (u.endsWith('/manifest.json')) return jsonRes(PKG_MANIFEST);
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' } as unknown as Response;
  }) as typeof fetch;
}

before(async () => {
  const r = await call('POST', '/admin/login', { body: { token: 'test-secret' } });
  const sc = r.headers['set-cookie'];
  cookie = String(Array.isArray(sc) ? sc[0] : sc).split(';')[0] ?? '';
});

test('ohne Session ist /admin/api/bootstrap 401', async () => {
  const r = await call('GET', '/admin/api/bootstrap');
  assert.equal(r.status, 401);
});

test('Issue #10: GET /admin/ mit Bearer ohne Cookie -> 200 (UI)', async () => {
  const r = await call('GET', '/admin/', { token: 'test-secret' });
  assert.equal(r.status, 200);
  assert.match(String(r.headers['content-type'] ?? ''), /text\/html/);
});

test('Issue #10: GET /admin/ ohne Token/Cookie -> 401 (JSON)', async () => {
  const r = await call('GET', '/admin/');
  assert.equal(r.status, 401);
});

test('Issue #10: GET /admin/ ohne Auth, Accept html -> Redirect zum Login', async () => {
  const r = await call('GET', '/admin/', { accept: 'text/html' });
  assert.equal(r.status, 302);
  assert.equal(String(r.headers['location'] ?? ''), '/admin/login.html');
});

test('Wurzel: GET /admin mit Bearer -> 302 auf /admin/ (Trailing-Slash)', async () => {
  const r = await call('GET', '/admin', { token: 'test-secret' });
  assert.equal(r.status, 302);
  assert.equal(String(r.headers['location'] ?? ''), '/admin/');
});

test('Wurzel: GET /admin?x=1 mit Bearer erhaelt den Query-String', async () => {
  const r = await call('GET', '/admin?x=1', { token: 'test-secret' });
  assert.equal(r.status, 302);
  assert.equal(String(r.headers['location'] ?? ''), '/admin/?x=1');
});

test('Wurzel: Bare-/admin mit HTML laeuft zuerst in die Auth-Umleitung', async () => {
  // Der Slash-Redirect laeuft erst nach Auth; ohne Session gewinnt die
  // Login-Umleitung (sonst wuerde der Query-String an /admin/ gehaengt).
  const r = await call('GET', '/admin?x=1', { accept: 'text/html' });
  assert.equal(r.status, 302);
  assert.equal(String(r.headers['location'] ?? ''), '/admin/login.html');
});

test('Wurzel: Bare-/admin ohne Auth und ohne HTML -> 401', async () => {
  const r = await call('GET', '/admin');
  assert.equal(r.status, 401);
});

test('Issue #10: GET /admin/login.html bleibt ohne Auth erreichbar', async () => {
  const r = await call('GET', '/admin/login.html', { accept: 'text/html' });
  assert.equal(r.status, 200);
});

test('login: falsches Token 401, richtiges Token setzt va_session-Cookie', async () => {
  resetRateLimitsForTests();
  const bad = await call('POST', '/admin/login', { body: { token: 'falsch' } });
  assert.equal(bad.status, 401);
  const good = await call('POST', '/admin/login', { body: { token: 'test-secret' } });
  assert.equal(good.status, 200);
  assert.match(String(good.headers['set-cookie']), /va_session=/);
  assert.equal(good.text.includes('va_session'), false, 'Session-ID nicht im Body');
});

test('login: Rate-Limit greift nach zu vielen Versuchen (429)', async () => {
  resetRateLimitsForTests();
  let last = 0;
  for (let i = 0; i < 11; i++) {
    const r = await call('POST', '/admin/login', { body: { token: 'falsch' } });
    last = r.status;
  }
  assert.equal(last, 429);
  resetRateLimitsForTests();
});

test('bootstrap mit Cookie liefert Settings und Actions', async () => {
  const r = await call('GET', '/admin/api/bootstrap', { cookie });
  assert.equal(r.status, 200);
  const j = r.json as { settings: Record<string, string>; actions: unknown[]; servers: unknown[] };
  assert.equal(typeof j.settings, 'object');
  assert.ok(Array.isArray(j.actions));
  assert.ok(Array.isArray(j.servers));
});

test('settings: PUT speichert, fehlendes Objekt ist 400', async () => {
  const ok = await call('PUT', '/admin/api/settings', { cookie, body: { settings: { test_route_key: 'abc' } } });
  assert.equal(ok.status, 200);
  assert.equal((ok.json as { settings: Record<string, string> }).settings.test_route_key, 'abc');
  const bad = await call('PUT', '/admin/api/settings', { cookie, body: {} });
  assert.equal(bad.status, 400);
  const rest = await call('POST', '/admin/api/settings/restore-defaults', { cookie, body: {} });
  assert.equal(rest.status, 200);
});

test('functions: CRUD ueber die Admin-API', async () => {
  const created = await call('POST', '/admin/api/functions', {
    cookie,
    body: { name: 'test_route_fn', template: 'Hallo ' },
  });
  assert.equal(created.status, 200);
  const id = (created.json as { function: { id: number } }).function.id;

  const invalid = await call('POST', '/admin/api/functions', { cookie, body: { name: 'X', template: '' } });
  assert.equal(invalid.status, 400);

  const updated = await call('PUT', `/admin/api/functions/${id}`, {
    cookie,
    body: { name: 'test_route_fn', template: 'Hallo 2' },
  });
  assert.equal(updated.status, 200);

  const list = await call('GET', '/admin/api/functions', { cookie });
  assert.ok(Array.isArray((list.json as { functions: unknown[] }).functions));

  const del = await call('DELETE', `/admin/api/functions/${id}`, { cookie });
  assert.equal(del.status, 200);
});

test('actions: CRUD + Validierung ueber die Admin-API', async () => {
  const created = await call('POST', '/admin/api/actions', {
    cookie,
    body: { name: 'test_route_action', mode: 'llm', trigger_phrases: '["test phrase"]', template: 'Hi' },
  });
  assert.equal(created.status, 200);
  const id = (created.json as { action: { id: number } }).action.id;

  const invalid = await call('POST', '/admin/api/actions', { cookie, body: { name: 'x', mode: 'bogus' } });
  assert.equal(invalid.status, 400);

  const updated = await call('PUT', `/admin/api/actions/${id}`, { cookie, body: { name: 'test_route_action', mode: 'llm' } });
  assert.equal(updated.status, 200);

  const del = await call('DELETE', `/admin/api/actions/${id}`, { cookie });
  assert.equal(del.status, 200);
});

test('indexes: GET liefert konfigurierte Quellen', async () => {
  const r = await call('GET', '/admin/api/indexes', { cookie });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray((r.json as { indexes: unknown[] }).indexes));
});

test('mcp-servers: CRUD, Maskierung und env-COALESCE', async () => {
  const created = await call('POST', '/admin/api/mcp-servers', {
    cookie,
    body: {
      name: 'route-srv',
      url: 'http://127.0.0.1:9/x',
      auth_token: 'geheim',
      transport: 'stdio',
      command: 'true',
      args: [],
      env: 'K=v',
    },
  });
  assert.equal(created.status, 200);
  const id = (created.json as { server: { id: number } }).server.id;

  const list = await call('GET', '/admin/api/mcp-servers', { cookie });
  const row = (list.json as { servers: { name: string; auth_token: string | null; env: string | null }[] }).servers.find(
    (s) => s.name === 'route-srv'
  );
  assert.ok(row);
  assert.equal(row.auth_token, null);
  assert.equal(row.env, null);

  // PUT ohne env laesst den Wert unveraendert (COALESCE, F-34).
  const put = await call('PUT', `/admin/api/mcp-servers/${id}`, {
    cookie,
    body: { name: 'route-srv', url: 'http://127.0.0.1:9/x', auth_token: 'neu', transport: 'stdio', command: 'true', args: [] },
  });
  assert.equal(put.status, 200);
  const dbRow = getDb().prepare('SELECT env FROM mcp_servers WHERE id = ?').get(id) as { env: string | null };
  assert.equal(dbRow.env, '{"K":"v"}');

  const health = await call('POST', '/admin/api/mcp-servers/999999/health', { cookie, body: {} });
  assert.equal(health.status, 404);

  const del = await call('DELETE', `/admin/api/mcp-servers/${id}`, { cookie });
  assert.equal(del.status, 200);
});

test('tools: GET liefert MCP- und Funktions-Fassade', async () => {
  const r = await call('GET', '/admin/api/tools', { cookie });
  assert.equal(r.status, 200);
  const j = r.json as { mcp: unknown[]; functions: unknown[] };
  assert.ok(Array.isArray(j.mcp));
  assert.ok(Array.isArray(j.functions));
});

test('logs und usage sind lesbar', async () => {
  const logs = await call('GET', '/admin/api/logs', { cookie });
  assert.equal(logs.status, 200);
  const usage = await call('GET', '/admin/api/usage', { cookie });
  assert.equal(usage.status, 200);
});

test('lambda-trace: POST quittiert mit 204 (nur API_TOKEN, keine Session)', async () => {
  const r = await call('POST', '/api/lambda-trace', { token: 'test-query-secret', body: { sessionId: 's1', event: 'test', elapsedMs: 5 } });
  assert.equal(r.status, 204);
  // Admin-Session autorisiert die Adapter-API nicht mehr.
  assert.equal((await call('POST', '/api/lambda-trace', { cookie, body: {} })).status, 401);
});

test('query: fehlender text 400, ohne Auth 401', async () => {
  const bad = await call('POST', '/api/query', { token: 'test-query-secret', body: {} });
  assert.equal(bad.status, 400);
  const noAuth = await call('POST', '/admin/api/query', { body: { text: 'hallo' } });
  assert.equal(noAuth.status, 401);
});

test('#1: /api/query akzeptiert nur API_TOKEN, nicht ADMIN_TOKEN/Session', async () => {
  // ADMIN_TOKEN (Admin) darf die Adapter-API NICHT oeffnen.
  assert.equal((await call('POST', '/api/query', { token: 'test-secret', body: { text: 'hi' } })).status, 401);
  // Admin-Session ebenso wenig.
  assert.equal((await call('POST', '/api/query', { cookie, body: { text: 'hi' } })).status, 401);
  // API_TOKEN autorisiert (Route erreicht -> 400 wegen fehlendem text).
  assert.equal((await call('POST', '/api/query', { token: 'test-query-secret', body: {} })).status, 400);
});

test('#3: /api/query kappt zu langen Text (413) und rate-limitet (429)', async () => {
  resetRateLimitsForTests();
  const long = await call('POST', '/api/query', { token: 'test-query-secret', body: { text: 'x'.repeat(501) } });
  assert.equal(long.status, 413);
  // Zwei Anfragen erlaubt (QUERY_RATE_MAX=2), die dritte wird abgewiesen.
  await call('POST', '/api/query', { token: 'test-query-secret', body: { text: 'hallo' } });
  await call('POST', '/api/query', { token: 'test-query-secret', body: { text: 'hallo' } });
  const third = await call('POST', '/api/query', { token: 'test-query-secret', body: { text: 'hallo' } });
  assert.equal(third.status, 429);
  resetRateLimitsForTests();
});

test('indexes: PUT/DELETE inkl. Validierung', async () => {
  const ok = await call('PUT', '/admin/api/indexes/ma', {
    cookie,
    body: { config: JSON.stringify({ tool: 'x_tool', args: {} }) },
  });
  assert.equal(ok.status, 200);
  const list = await call('GET', '/admin/api/indexes', { cookie });
  assert.ok((list.json as { indexes: { key: string }[] }).indexes.some((i) => i.key === 'ma'));
  assert.equal((await call('PUT', '/admin/api/indexes/ma', { cookie, body: { config: '{kaputt' } })).status, 400);
  assert.equal((await call('PUT', '/admin/api/indexes/ma', { cookie, body: { config: '{}' } })).status, 400);
  assert.equal((await call('PUT', '/admin/api/indexes/BAD!', { cookie, body: { config: '{"tool":"x"}' } })).status, 400);
  assert.equal((await call('DELETE', '/admin/api/indexes/ma', { cookie })).status, 200);
  assert.equal((await call('DELETE', '/admin/api/indexes/BAD!', { cookie })).status, 400);
});

test('functions/preview rendert Template mit args', async () => {
  const r = await call('POST', '/admin/api/functions/preview', {
    cookie,
    body: { template: 'Hallo {{ args.name }}', args: { name: 'Welt' } },
  });
  assert.equal(r.status, 200);
  assert.equal((r.json as { rendered: { speech: string } }).rendered.speech, 'Hallo Welt');
});

test('packages: registry und manifest (Fetch gestubbt)', async () => {
  stubRegistry();
  const reg = await call('GET', '/admin/api/packages/registry', { cookie });
  assert.equal(reg.status, 200);
  assert.ok(Array.isArray((reg.json as { packages: unknown[] }).packages));
  const man = await call('GET', '/admin/api/packages/manifest/test-package', { cookie });
  assert.equal(man.status, 200);
  assert.equal((man.json as { manifest: { id: string } }).manifest.id, 'test-package');
});

test('packages: preview, install (dryRun), conflicts, Liste, backup/restore', async () => {
  const prev = await call('POST', '/admin/api/packages/preview', { cookie, body: { manifest: PKG_MANIFEST } });
  assert.equal(prev.status, 200);
  assert.ok(Array.isArray((prev.json as { requiredParams: unknown[] }).requiredParams));

  const install = await call('POST', '/admin/api/packages/test-package/install', {
    cookie,
    body: { manifest: PKG_MANIFEST, params: { host: '127.0.0.1' }, dryRun: true },
  });
  assert.equal(install.status, 200);
  assert.ok((install.json as { report: unknown }).report);

  const conflicts = await call('GET', '/admin/api/packages/test-package/conflicts', { cookie });
  assert.equal(conflicts.status, 200);

  stubRegistry();
  const list = await call('GET', '/admin/api/packages', { cookie });
  assert.equal(list.status, 200);

  const backup = await call('GET', '/admin/api/backup', { cookie });
  assert.equal(backup.status, 200);
  assert.ok(Array.isArray((backup.json as { servers: unknown[] }).servers));

  assert.equal((await call('POST', '/admin/api/backup/restore', { cookie, body: {} })).status, 400);
  const restore = await call('POST', '/admin/api/backup/restore', {
    cookie,
    body: { confirm: true, backup: { kind: 'smartpilot-config-backup', settings: { test_restore_key: 'v' } } },
  });
  assert.equal(restore.status, 200);
  assert.equal((restore.json as { ok: boolean }).ok, true);
});

test('index/assist + index/apply (LLM und MCP gestubbt)', async () => {
  createMcpServer({
    name: 'assist-idx',
    url: 'https://mcp.example.org/rpc',
    auth_token: null,
    transport: 'http',
    command: null,
    args: null,
    env: null,
    inventory_prompt: null,
    enabled: 1,
  });
  invalidateMcpCache();
  const draft = { tool: 'ha_eval_template', args: { template: 'x' }, sampleQueries: ['licht'] };
  const pipe =
    'light.1|Wohnzimmer|on||Licht|\nlight.2|Kueche|off||Lampe|\nlight.3|Bad|on||Spiegel|\nlight.4|Flur|on||Strahler|\nlight.5|Keller|off||Birne|';
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/chat/completions')) {
      return jsonRes({ choices: [{ message: { role: 'assistant', content: JSON.stringify(draft) } }] });
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as { method?: string };
    if (body.method === 'tools/list') return jsonRes({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'ha_eval_template', description: '' }] } });
    if (body.method === 'tools/call') return jsonRes({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: pipe }] } });
    return jsonRes({ jsonrpc: '2.0', id: 1, result: {} });
  }) as typeof fetch;
  try {
    const assist = await call('POST', '/admin/api/index/assist', { cookie, body: { goal: 'Test', indexKey: 'itest' } });
    assert.equal(assist.status, 200);
    const res = assist.json as { draft: { tool: string } | null; validation: { ok: boolean } | null };
    assert.equal(res.draft?.tool, 'ha_eval_template');
    assert.equal(res.validation?.ok, true);

    const apply = await call('POST', '/admin/api/index/apply', { cookie, body: { draft, indexKey: 'itest' } });
    assert.equal(apply.status, 200);
    assert.equal((apply.json as { ok: boolean }).ok, true);
    assert.ok(getSetting('entity_index_itest'));
  } finally {
    invalidateMcpCache();
    getDb().prepare("DELETE FROM mcp_servers WHERE name = 'assist-idx'").run();
    deleteSetting('entity_index_itest');
  }
});

test('admin: Fehlerpfade (400/404)', async () => {
  const fnList = await call('GET', '/admin/api/functions', { cookie });
  const anyId = (fnList.json as { functions: { id: number }[] }).functions[0]?.id ?? 999999;
  // PUT mit ungueltigem Namen -> normalize wirft -> 400.
  assert.equal((await call('PUT', `/admin/api/functions/${anyId}`, { cookie, body: { name: 'X', template: '' } })).status, 400);
  // PUT einer nicht vorhandenen Action -> 404.
  assert.equal((await call('PUT', '/admin/api/actions/999999', { cookie, body: { name: 'a', mode: 'llm' } })).status, 404);
  // DELETE einer nicht vorhandenen Function -> 200 ok.
  assert.equal((await call('DELETE', '/admin/api/functions/999999', { cookie })).status, 200);
});

test('packages: Fehlerpfade (400/502)', async () => {
  // Leeres Manifest -> 400.
  assert.equal((await call('POST', '/admin/api/packages/preview', { cookie, body: { manifest: { id: '' } } })).status, 400);
  // minGatewayVersion zu hoch -> 400.
  const tooNew = { ...PKG_MANIFEST, minGatewayVersion: '999.0.0' };
  assert.equal(
    (await call('POST', '/admin/api/packages/test-package/install', { cookie, body: { manifest: tooNew, dryRun: true } })).status,
    400
  );
  // restore mit falscher kind -> 400.
  assert.equal(
    (await call('POST', '/admin/api/backup/restore', { cookie, body: { confirm: true, backup: { kind: 'nope' } } })).status,
    400
  );
  // Uninstall eines nicht installierten Pakets -> 200 oder 400 (Fehlerpfad).
  assert.ok([200, 400].includes((await call('POST', '/admin/api/packages/test-package/uninstall', { cookie, body: {} })).status));

  // Registry nicht erreichbar: sprachwechsel erzwingt Neuladen des Caches.
  setSetting('registry_language', 'fr');
  globalThis.fetch = (async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => '' }) as unknown as Response) as typeof fetch;
  assert.equal((await call('GET', '/admin/api/packages/manifest/test-package', { cookie })).status, 502);
  const list = await call('GET', '/admin/api/packages', { cookie });
  assert.equal(list.status, 200);
  assert.equal((list.json as { registry: unknown }).registry, null);
  deleteSetting('registry_language');
});
